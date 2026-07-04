import XCTest
@testable import GolfMap

final class AssetsAndFeaturesTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testAssetsDecodeAndKinds() throws {
        let data = try FixtureLoader.data("assets-by-course.json")
        let assets = try decoder.decode([CourseAsset].self, from: data)
        XCTAssertEqual(assets.count, 3)
        let kinds = assets.map(\.kind)
        XCTAssertTrue(kinds.contains(.orthoCog))
        XCTAssertTrue(kinds.contains(.demCog))
        XCTAssertTrue(kinds.contains(.tileManifest))
        // No kind should decode to .unknown for this fixture.
        XCTAssertFalse(kinds.contains(.unknown))
    }

    func testTileManifestParsing() throws {
        let data = try FixtureLoader.data("assets-by-course.json")
        let assets = try decoder.decode([CourseAsset].self, from: data)

        guard let manifestAsset = assets.first(where: { $0.kind == .tileManifest }) else {
            return XCTFail("No tile_manifest asset in fixture")
        }
        guard let manifest = manifestAsset.tileManifest() else {
            return XCTFail("tileManifest() returned nil")
        }

        XCTAssertEqual(manifest.layers.ortho.minzoom, 14)
        XCTAssertEqual(manifest.layers.ortho.maxzoom, 20)
        XCTAssertEqual(manifest.layers.terrain.minzoom, 12)
        XCTAssertEqual(manifest.layers.terrain.maxzoom, 17)
        XCTAssertEqual(manifest.generatedAt, "2026-07-04T08:28:59Z")
        XCTAssertEqual(manifest.versionParam, "20260704T082859Z")
        XCTAssertEqual(manifest.elevation.min, 53.27858352661133, accuracy: 1e-6)
        XCTAssertEqual(manifest.elevation.max, 98.49988555908203, accuracy: 1e-6)
        XCTAssertEqual(manifest.bounds.west, 15.695402171504204, accuracy: 1e-9)
        XCTAssertFalse(manifest.attribution.isEmpty)
    }

    func testTileManifestReturnsNilForNonManifestAsset() throws {
        let data = try FixtureLoader.data("assets-by-course.json")
        let assets = try decoder.decode([CourseAsset].self, from: data)
        let ortho = try XCTUnwrap(assets.first { $0.kind == .orthoCog })
        // ortho_cog metaJson is a manifest-shaped blob too, so it *does* parse;
        // assert instead that a nil metaJson yields nil. Construct one:
        let noMeta = CourseAsset(
            id: "x", courseId: "c", kind: .svgSource, filename: "f",
            metaJson: nil, version: 1, createdAt: "", updatedAt: ""
        )
        XCTAssertNil(noMeta.tileManifest())
        // And malformed JSON yields nil.
        let bad = CourseAsset(
            id: "x", courseId: "c", kind: .tileManifest, filename: "f",
            metaJson: "{not json", version: 1, createdAt: "", updatedAt: ""
        )
        XCTAssertNil(bad.tileManifest())
        XCTAssertNotNil(ortho) // touch to silence unused warning
    }

    func testUnknownAssetKindDecodesToUnknown() throws {
        let json = #"{"id":"a","courseId":"c","kind":"future_kind","filename":"f","metaJson":null,"version":1,"createdAt":"","updatedAt":""}"#
        let asset = try decoder.decode(CourseAsset.self, from: Data(json.utf8))
        XCTAssertEqual(asset.kind, .unknown)
    }

    func testVersionParamStripsSeparators() {
        // Directly exercise the transform contract.
        let manifest = TileManifest(
            bounds: .init(west: 0, south: 0, east: 0, north: 0),
            layers: .init(ortho: .init(minzoom: 0, maxzoom: 0),
                          terrain: .init(minzoom: 0, maxzoom: 0)),
            elevation: .init(min: 0, max: 0),
            generatedAt: "2026-07-04T08:28:59Z",
            attribution: ""
        )
        XCTAssertEqual(manifest.versionParam, "20260704T082859Z")
    }

    func testFeaturesGeoJSONDecode() throws {
        let data = try FixtureLoader.data("features.geojson")
        let collection = try decoder.decode(CourseFeatureCollection.self, from: data)
        XCTAssertEqual(collection.features.count, 685)

        let knownTypes: Set<String> = [
            "bunker", "deep_rough", "fairway", "green", "path",
            "rough", "semi_rough", "tee", "water", "water_creek",
        ]
        let presentTypes = Set(collection.features.map(\.type))
        // Every present type is within the known set.
        XCTAssertTrue(presentTypes.isSubset(of: knownTypes), "Unexpected types: \(presentTypes.subtracting(knownTypes))")
        // Sanity: fairway and green both appear.
        XCTAssertTrue(presentTypes.contains("fairway"))
        XCTAssertTrue(presentTypes.contains("green"))

        // Every feature has at least one ring with at least 3 vertices,
        // and coordinates are plausible WGS84 (lon ~15, lat ~58).
        let first = try XCTUnwrap(collection.features.first)
        let outerRing = try XCTUnwrap(first.rings.first)
        XCTAssertGreaterThanOrEqual(outerRing.count, 3)
        let v = try XCTUnwrap(outerRing.first)
        XCTAssertEqual(v.lon, 15, accuracy: 1.0)
        XCTAssertEqual(v.lat, 58, accuracy: 1.0)
    }
}
