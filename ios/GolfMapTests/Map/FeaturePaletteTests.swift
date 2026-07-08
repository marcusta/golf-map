import XCTest
@testable import GolfMap

final class FeaturePaletteTests: XCTestCase {

    /// Raw values must match the server/web feature type strings exactly.
    func testRawValuesMatchServerTypes() {
        XCTAssertEqual(
            CourseFeatureType.allCases.map(\.rawValue),
            [
                "tee", "fairway", "green", "bunker", "semi_rough", "rough",
                "deep_rough", "water", "water_creek", "path", "outside",
            ]
        )
    }

    /// Colors ported from web/src/draw/feature-palette.ts FEATURE_STYLES —
    /// keep in sync so app and editor render identically.
    func testFillAndOutlineColorsMatchWebPalette() {
        let expected: [CourseFeatureType: (fill: String, outline: String)] = [
            .green: ("#8fe0a0", "#4fa863"),
            .tee: ("#63b578", "#3c8a52"),
            .fairway: ("#4d9e58", "#2f7d43"),
            .semiRough: ("#79a860", "#557f41"),
            .rough: ("#55803f", "#3b5f2b"),
            .deepRough: ("#3c5c2e", "#294420"),
            .bunker: ("#e9d8a0", "#c4a95e"),
            .water: ("#4f8fd0", "#2f6aa8"),
            .waterCreek: ("#6fb1e0", "#4585b8"),
            .path: ("#b6a68d", "#8f7f66"),
            .outside: ("#9097a0", "#6a7178"),
        ]
        XCTAssertEqual(expected.count, CourseFeatureType.allCases.count)
        for (type, colors) in expected {
            XCTAssertEqual(type.fillHex, colors.fill, "\(type) fill")
            XCTAssertEqual(type.outlineHex, colors.outline, "\(type) outline")
        }
    }

    /// Bottom → top: broad ground types first, small features on top
    /// (web TYPE_Z_ORDER).
    func testZOrderMatchesWeb() {
        XCTAssertEqual(
            FeaturePalette.zOrder.map(\.rawValue),
            [
                "outside", "deep_rough", "rough", "semi_rough", "fairway",
                "tee", "green", "bunker", "water", "water_creek", "path",
            ]
        )
    }

    func testTypeColorExpressionCoversAllTypesWithFallback() throws {
        let expr = FeaturePalette.typeColorExpression(outline: false)
        XCTAssertEqual(expr[0] as? String, "match")
        XCTAssertEqual(expr[1] as? [String], ["get", "type"])
        // match + get + 11 label/color pairs + fallback
        XCTAssertEqual(expr.count, 2 + CourseFeatureType.allCases.count * 2 + 1)
        XCTAssertEqual(expr.last as? String, FeaturePalette.fallbackHex)

        // Spot-check a pair: label immediately followed by its color.
        let labels = expr.dropFirst(2).dropLast().compactMap { $0 as? String }
        let fairwayIndex = try XCTUnwrap(labels.firstIndex(of: "fairway"))
        XCTAssertEqual(labels[fairwayIndex + 1], CourseFeatureType.fairway.fillHex)

        let outlineExpr = FeaturePalette.typeColorExpression(outline: true)
        let outlineLabels = outlineExpr.dropFirst(2).dropLast().compactMap { $0 as? String }
        let greenIndex = try XCTUnwrap(outlineLabels.firstIndex(of: "green"))
        XCTAssertEqual(outlineLabels[greenIndex + 1], CourseFeatureType.green.outlineHex)
    }

    func testSortKeyExpressionAssignsAscendingKeysInZOrder() {
        let expr = FeaturePalette.typeSortKeyExpression()
        XCTAssertEqual(expr[0] as? String, "match")
        XCTAssertEqual(expr[1] as? [String], ["get", "type"])
        XCTAssertEqual(expr.count, 2 + FeaturePalette.zOrder.count * 2 + 1)
        // Unknown types sort below everything.
        XCTAssertEqual(expr.last as? Int, -1)
        // outside = 0 (bottom), path = 10 (top).
        XCTAssertEqual(expr[2] as? String, "outside")
        XCTAssertEqual(expr[3] as? Int, 0)
        XCTAssertEqual(expr[expr.count - 3] as? String, "path")
        XCTAssertEqual(expr[expr.count - 2] as? Int, 10)
    }

    /// D23/D24: rendering reads the server-assigned `stackKey`, falling back
    /// to the fixed type order only for bundles without that property.
    func testStackSortKeyExpressionCoalescesStackKeyOverTypeOrder() throws {
        let expr = FeaturePalette.stackSortKeyExpression()
        XCTAssertEqual(expr[0] as? String, "coalesce")
        XCTAssertEqual(expr[1] as? [String], ["get", "stackKey"])
        let fallback = try XCTUnwrap(expr[2] as? [Any])
        XCTAssertEqual(fallback.map { "\($0)" }, FeaturePalette.typeSortKeyExpression().map { "\($0)" })
    }
}
