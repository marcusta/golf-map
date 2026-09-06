import XCTest
@testable import GolfMap

final class TreeStemsTests: XCTestCase {
    private let origin = Vec2(x: 0, y: 0)
    private let target = Vec2(x: 200, y: 0)

    private func features(_ rows: [[Double]]) -> [TreeFeatureInput] {
        rows.map { TreeStem(x: $0[0], y: $0[1], heightM: $0[2], crownRadiusM: $0[3], groundM: $0[4]).feature }
    }

    func testExactChordTangentMissAndOriginInside() {
        let hits = treeCrossingsAlongLine(origin, target, features([[100,3,10,5,50], [120,5,10,5,50], [140,5.1,10,5,50], [0,0,10,2,50]]))
        XCTAssertEqual(hits.map { [$0.entryM, $0.exitM] }, [[0,2], [96,104], [120,120]])
    }

    func testAbsoluteGroundAndNarrowSampleValley() {
        let shot = TreeClearanceShot(carryM: 200, apexM: 30, samples: [
            .init(d: 0, h: 30), .init(d: 100.25, h: 19), .init(d: 100.5, h: 30), .init(d: 200, h: 30)
        ])
        let result = treeClearance(origin, target, features([[100,0,10,5,60]]), shot,
                                   .init(originGroundM: 50, groundAt: { _ in 999 }))
        XCTAssertEqual(result.summary.status, .blocked)
        XCTAssertEqual(result.summary.worst?.minClearanceM, -1)
        XCTAssertEqual(result.summary.worst?.worstAtM, 100.25)
    }

    func testMissingAbsoluteOriginGroundIsUnknown() {
        var options = TreeClearanceOptions()
        options.originGroundKnown = false
        let result = treeClearance(origin, target, features([[100,0,10,5,80]]), .init(carryM: 200, apexM: 30), options)
        XCTAssertEqual(result.summary.status, .unknown)
        XCTAssertNil(result.crossings.first?.minClearanceM)
    }

    func testEntryEdgeGapAndBeyondCarry() {
        let shot = TreeClearanceShot(carryM: 200, apexM: 20)
        XCTAssertEqual(treeClearance(origin, target, features([[100,0,19,30,0]]), shot).summary.status, .blocked)
        XCTAssertTrue(treeClearance(origin, target, features([[100,8,30,5,0], [100,-8,30,5,0]]), shot).crossings.isEmpty)
        let result = treeClearance(origin, target, features([[250,0,20,5,0]]), shot)
        XCTAssertEqual(result.beyondCarry.count, 1)
        XCTAssertEqual(result.summary.status, .clears)
    }

    func testStrictAssetAndEmptyAuthority() throws {
        let prefix = #"{"version":1,"crs":"EPSG:3006","fields":["x","y","heightM","crownRadiusM","groundM"],"trees":"#
        XCTAssertEqual(try TreeStemsAsset.parse(Data((prefix + "[]}").utf8)), [])
        let valid = Data((prefix + "[[100,3,10,5,50]]}").utf8)
        let stems = try TreeStemsAsset.parse(valid)
        XCTAssertEqual(stems.first?.groundM, 50)
        XCTAssertEqual(TreeFeatureStore(features: stems.map(\.feature)).candidates(from: origin, to: target).count, 1)
        for rows in ["[[0,0,2,0,0]]}", "[[0,0,2,1]]}", "[[true,0,2,1,0]]}"] {
            XCTAssertThrowsError(try TreeStemsAsset.parse(Data((prefix + rows).utf8)))
        }
        XCTAssertThrowsError(try TreeStemsAsset.parse(Data((prefix.replacingOccurrences(of: "3006", with: "4326") + "[]}").utf8)))
        XCTAssertThrowsError(try TreeStemsAsset.parse(Data((prefix.replacingOccurrences(of: "\"version\":1", with: "\"version\":3") + "[]}").utf8)))
        XCTAssertEqual(stems.first?.kind, .unknown)
    }

    func testVersionTwoCarriesKindAndVersionOneReadsUnknown() throws {
        let prefix = #"{"version":2,"crs":"EPSG:3006","fields":["x","y","heightM","crownRadiusM","groundM","kind"],"trees":"#
        let stems = try TreeStemsAsset.parse(Data((prefix + "[[100,3,10,5,50,0],[120,5,10,5,50,1],[140,5,3,1.5,50,2]]}").utf8))
        XCTAssertEqual(stems.map(\.kind), [.broadleaf, .conifer, .unknown])
        XCTAssertEqual(try TreeStemsAsset.parse(Data((prefix + "[]}").utf8)), [])
        for rows in ["[[100,3,10,5,50]]}", "[[100,3,10,5,50,3]]}", "[[100,3,10,5,50,0.5]]}", "[[100,3,10,5,50,-1]]}"] {
            XCTAssertThrowsError(try TreeStemsAsset.parse(Data((prefix + rows).utf8)))
        }
        // Version mismatch with the field list fails either way.
        let v1Fields = #"{"version":2,"crs":"EPSG:3006","fields":["x","y","heightM","crownRadiusM","groundM"],"trees":[]}"#
        XCTAssertThrowsError(try TreeStemsAsset.parse(Data(v1Fields.utf8)))
        let v2FieldsOnV1 = #"{"version":1,"crs":"EPSG:3006","fields":["x","y","heightM","crownRadiusM","groundM","kind"],"trees":[]}"#
        XCTAssertThrowsError(try TreeStemsAsset.parse(Data(v2FieldsOnV1.utf8)))
        // Clearance ignores kind; the 1.5 m bush 5 m off the line is a miss.
        let hits = treeCrossingsAlongLine(origin, target, stems.map(\.feature))
        XCTAssertEqual(hits.map { [$0.entryM, $0.exitM] }, [[96,104], [120,120]])
    }
}
