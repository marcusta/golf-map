import XCTest
@testable import GolfMap

/// `TreeFeatureStore`: geojson parsing of generated canopy features
/// (`attributes` + `source`), the bbox candidate prefilter, and its cost at
/// lidar scale (~2200 tree polygons per course).
final class TreePolygonsTests: XCTestCase {

    /// A square tree polygon (WGS84 geojson) centred on `center` with `halfM` half-size.
    private func squareFeature(
        id: String, center: LatLon, halfM: Double,
        type: String = "trees", properties extra: String = ""
    ) -> String {
        let c = Sweref99TM.fromWGS84(center)
        let corners = [
            (c.x - halfM, c.y - halfM), (c.x + halfM, c.y - halfM),
            (c.x + halfM, c.y + halfM), (c.x - halfM, c.y + halfM), (c.x - halfM, c.y - halfM),
        ].map { Sweref99TM.toWGS84(x: $0.0, y: $0.1) }
        let ring = corners.map { "[\($0.lon), \($0.lat)]" }.joined(separator: ",")
        return """
        {"type":"Feature","id":"\(id)","properties":{"courseId":"c1","holeId":null,"type":"\(type)"\(extra)},
         "geometry":{"type":"Polygon","coordinates":[[\(ring)]]}}
        """
    }

    private func collection(_ features: [String]) -> Data {
        Data("{\"type\":\"FeatureCollection\",\"features\":[\(features.joined(separator: ","))]}".utf8)
    }

    private let tee = LatLon(lat: 58.3600, lon: 15.7100)

    func testParsesAttributesSourceAndSkipsNonTreeFeatures() throws {
        let generated = squareFeature(
            id: "t1", center: tee, halfM: 5,
            properties: #","source":"lidar-canopy","attributes":{"heightMaxM":21.4,"heightP90M":18.2,"heightMeanM":12.0,"areaM2":340,"note":"x","dense":true,"bad":null,"nested":{"a":1}}"#
        )
        let handDrawn = squareFeature(id: "t2", center: tee, halfM: 5)
        let bunker = squareFeature(id: "b1", center: tee, halfM: 5, type: "bunker", properties: #","attributes":{"heightP90M":9}"#)

        let store = try TreeFeatureStore(featuresGeoJSON: collection([generated, handDrawn, bunker]))
        XCTAssertEqual(store.features.count, 2)
        XCTAssertEqual(store.features.map(\.id), ["t1", "t2"])
        XCTAssertEqual(store.sources, ["lidar-canopy", nil])
        XCTAssertEqual(store.holeIds, [nil, nil])
        XCTAssertEqual(store.features[0].points.count, 5)

        let attrs = try XCTUnwrap(store.features[0].attributes)
        XCTAssertEqual(attrs["heightMaxM"], .number(21.4))
        XCTAssertEqual(attrs["heightP90M"], .number(18.2))
        XCTAssertEqual(attrs["areaM2"], .number(340))
        XCTAssertEqual(attrs["note"], .string("x"))
        XCTAssertEqual(attrs["dense"], .bool(true))
        XCTAssertNil(attrs["bad"])
        XCTAssertNil(attrs["nested"])
        XCTAssertEqual(treeHeightM(store.features[0]), 18.2)

        XCTAssertNil(store.features[1].attributes)
        XCTAssertNil(treeHeightM(store.features[1]))
    }

    func testParsesMultiPolygonAsOneFeaturePerPart() throws {
        let a = Sweref99TM.fromWGS84(tee)
        func ring(_ dx: Double) -> String {
            [(a.x + dx, a.y), (a.x + dx + 4, a.y), (a.x + dx + 4, a.y + 4), (a.x + dx, a.y + 4), (a.x + dx, a.y)]
                .map { Sweref99TM.toWGS84(x: $0.0, y: $0.1) }
                .map { "[\($0.lon), \($0.lat)]" }.joined(separator: ",")
        }
        let json = """
        {"type":"Feature","id":"m1","properties":{"courseId":"c1","type":"trees","source":"lidar-canopy","attributes":{"heightMaxM":15}},
         "geometry":{"type":"MultiPolygon","coordinates":[[[\(ring(0))]],[[\(ring(50))]]]}}
        """
        let store = try TreeFeatureStore(featuresGeoJSON: collection([json]))
        XCTAssertEqual(store.features.count, 2)
        XCTAssertEqual(store.sources, ["lidar-canopy", "lidar-canopy"])
        XCTAssertEqual(store.features.map { treeHeightM($0) }, [15, 15])
    }

    func testRealFixtureHasNoTreesAndParsesCleanly() throws {
        let store = try TreeFeatureStore(featuresGeoJSON: FixtureLoader.data("features.geojson"))
        XCTAssertEqual(store.features.count, 0)
        XCTAssertEqual(store.candidates(from: Vec2(x: 0, y: 0), to: Vec2(x: 100, y: 0)), [])
    }

    func testBBox() {
        let b = TreeFeatureStore.BBox.of([Vec2(x: 3, y: -2), Vec2(x: -1, y: 7), Vec2(x: 2, y: 2)])
        XCTAssertEqual(b, TreeFeatureStore.BBox(minX: -1, minY: -2, maxX: 3, maxY: 7))
        XCTAssertTrue(b.intersects(TreeFeatureStore.BBox(minX: 3, minY: 7, maxX: 10, maxY: 10)), "touching edges intersect")
        XCTAssertFalse(b.intersects(TreeFeatureStore.BBox(minX: 3.1, minY: 0, maxX: 10, maxY: 10)))
        XCTAssertTrue(b.expanded(by: 1).intersects(TreeFeatureStore.BBox(minX: 3.5, minY: 0, maxX: 10, maxY: 10)))
    }

    func testCandidatesKeepsRingsNearTheLineAndPreservesOrder() {
        func sq(_ x: Double, _ y: Double, id: String) -> TreeFeatureInput {
            TreeFeatureInput(
                type: "trees",
                points: [Vec2(x: x - 5, y: y - 5), Vec2(x: x + 5, y: y - 5), Vec2(x: x + 5, y: y + 5), Vec2(x: x - 5, y: y + 5)],
                id: id
            )
        }
        let store = TreeFeatureStore(features: [
            sq(300, 0, id: "past-target"), sq(150, 0, id: "on-line"), sq(100, 8, id: "within-pad"),
            sq(100, 40, id: "off-line"), sq(-20, 0, id: "behind"),
        ])
        let out = store.candidates(from: Vec2(x: 0, y: 0), to: Vec2(x: 200, y: 0), padM: 5)
        XCTAssertEqual(out.map(\.id), ["on-line", "within-pad"])
        // The ray scan runs past the target (TS parity: rings beyond the carry
        // are reported as `beyondCarry`); the prefilter is scoped to the
        // segment, so only crossings within the line length must agree.
        let full = treeCrossingsAlongLine(Vec2(x: 0, y: 0), Vec2(x: 200, y: 0), store.features)
        let pre = treeCrossingsAlongLine(Vec2(x: 0, y: 0), Vec2(x: 200, y: 0), out)
        XCTAssertEqual(full.filter { $0.entryM <= 200 }, pre)
        XCTAssertEqual(full.map(\.feature.id), ["on-line", "past-target"])
    }

    // MARK: - Performance at lidar scale

    /// 2200 synthetic tree polygons (12-gon each, ~8 m radius) scattered over a
    /// 1.5 km square; a 220 m shot line through the middle. Measures the full
    /// ray/ring scan versus bbox prefilter + scan and asserts identical results.
    func testPrefilterMatchesFullScanAt2200PolygonsAndReportsTiming() {
        var features: [TreeFeatureInput] = []
        features.reserveCapacity(2200)
        var seed: UInt64 = 0x9E3779B97F4A7C15
        func next() -> Double {
            // Deterministic LCG so timings compare run to run.
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double(seed >> 11) / Double(1 << 53)
        }
        for i in 0..<2200 {
            let cx = next() * 1500 - 750
            let cy = next() * 1500 - 750
            let r = 4 + next() * 8
            var pts: [Vec2] = []
            for k in 0..<12 {
                let a = Double(k) / 12 * 2 * .pi
                pts.append(Vec2(x: cx + r * cos(a), y: cy + r * sin(a)))
            }
            features.append(TreeFeatureInput(
                type: "trees", points: pts,
                attributes: ["heightP90M": .number(8 + next() * 20), "heightMaxM": .number(30)],
                id: "t\(i)"
            ))
        }
        let store = TreeFeatureStore(features: features)
        let o = Vec2(x: -110, y: 3), t = Vec2(x: 110, y: -3)
        let shot = TreeClearanceShot(carryM: 220, apexM: Apex.apexHeightM(220))

        func time(_ reps: Int, _ body: () -> Void) -> Double {
            let start = DispatchTime.now().uptimeNanoseconds
            for _ in 0..<reps { body() }
            return Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 / Double(reps)
        }

        var full = TreeClearanceResult(crossings: [], beyondCarry: [], summary: .init(status: .clears, worst: nil))
        var fast = full
        let fullMs = time(20) { full = treeClearance(o, t, store.features, shot) }
        let fastMs = time(20) {
            fast = treeClearance(o, t, store.candidates(from: o, to: t, padM: 5), shot)
        }
        // Carry == line length here, so every airborne crossing lies inside the
        // segment bbox: crossings and summary must be identical. `beyondCarry`
        // (rings past the target) is by design outside the prefilter's scope.
        XCTAssertEqual(full.crossings, fast.crossings, "bbox prefilter must not change the crossings")
        XCTAssertEqual(full.summary, fast.summary)
        XCTAssertEqual(fast.beyondCarry, [])
        XCTAssertGreaterThan(full.crossings.count, 0, "the line should cross some trees")

        let candidates = store.candidates(from: o, to: t, padM: 5).count
        print(String(
            format: "[perf] treeClearance over 2200 polygons: full scan %.3f ms, bbox prefilter+scan %.3f ms (%d candidates)",
            fullMs, fastMs, candidates
        ))
        XCTAssertLessThan(fastMs, 20, "prefiltered tree readout must stay far under a frame")
    }
}
