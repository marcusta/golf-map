import Foundation

/// Course feature types + golf palette, ported from the web editor
/// (`web/src/draw/feature-palette.ts`). Raw values match the `type` property
/// the server writes into features.geojson; hex colors must stay in sync with
/// the web `FEATURE_STYLES` table so the app and editor render identically.
public enum CourseFeatureType: String, CaseIterable, Sendable {
    case tee
    case fairway
    case green
    case bunker
    case semiRough = "semi_rough"
    case rough
    case deepRough = "deep_rough"
    case trees
    case water
    case waterCreek = "water_creek"
    case penaltyYellow = "penalty_yellow"
    case penaltyRed = "penalty_red"
    case oob
    case path
    case outside

    /// Semi-transparent fill color (opacity applied via `fill-opacity`).
    public var fillHex: String {
        switch self {
        case .green: "#7fc489"
        case .tee: "#5fa76e"
        case .fairway: "#4c9256"
        case .semiRough: "#7e9e56"
        case .rough: "#566e3a"
        case .deepRough: "#3c5730"
        case .trees: "#24402b"
        case .bunker: "#e1cc93"
        case .water: "#4c8fbe"
        case .waterCreek: "#77aed2"
        case .penaltyYellow: "#e8cb56"
        case .penaltyRed: "#de6152"
        case .oob: "#efeae0"
        case .path: "#c2a879"
        case .outside: "#8a8e90"
        }
    }

    /// Full-strength outline color.
    public var outlineHex: String {
        switch self {
        case .green: "#3f7a55"
        case .tee: "#34734a"
        case .fairway: "#2c6b3b"
        case .semiRough: "#4c6e37"
        case .rough: "#384e23"
        case .deepRough: "#26381c"
        case .trees: "#142619"
        case .bunker: "#b0894a"
        case .water: "#2e6389"
        case .waterCreek: "#3f7ba0"
        case .penaltyYellow: "#c39a2e"
        case .penaltyRed: "#b0402e"
        case .oob: "#3a4148"
        case .path: "#866b47"
        case .outside: "#565c61"
        }
    }
}

/// Style constants + MapLibre style-spec JSON expression builders for the
/// course feature overlay. Mirrors the web editor's rendering: one fill layer
/// + one outline layer, with per-type colors and a fixed golf z-order applied
/// via `fill-sort-key` / `line-sort-key` (higher key renders on top).
public enum FeaturePalette {
    /// Fallback color for unknown feature types.
    public static let fallbackHex = "#888888"
    /// Feature fill opacity — semi-transparent so ortho shows through
    /// (matches the web editor's 0.4).
    public static let fillOpacity = 0.4
    /// Outline width in points (web: 1.5).
    public static let outlineWidth = 1.5

    /// Fixed golf z-ordering, bottom → top: broad ground types first, small
    /// features (bunkers, water, paths) on top. Ported from web TYPE_Z_ORDER.
    public static let zOrder: [CourseFeatureType] = [
        .outside, .deepRough, .rough, .semiRough, .fairway,
        .tee, .green, .trees, .bunker, .water, .waterCreek,
        .penaltyYellow, .penaltyRed, .oob, .path,
    ]

    /// MapLibre `match` expression (style-spec JSON): feature `type` property
    /// → fill or outline color hex. Unknown types fall back to gray.
    public static func typeColorExpression(outline: Bool) -> [Any] {
        var expr: [Any] = ["match", ["get", "type"]]
        for type in CourseFeatureType.allCases {
            expr.append(type.rawValue)
            expr.append(outline ? type.outlineHex : type.fillHex)
        }
        expr.append(fallbackHex)
        return expr
    }

    /// MapLibre `match` expression: feature `type` → z-order sort key.
    /// Unknown types render below everything (-1). Superseded at render time
    /// by `stackSortKeyExpression()` (D23/D26, docs/decisions-feature-stack-2026-07-08.md)
    /// — this fixed type order now only backs the `stackKey`-missing fallback
    /// (stale bundles) and the server's insertion heuristic on create.
    public static func typeSortKeyExpression() -> [Any] {
        var expr: [Any] = ["match", ["get", "type"]]
        for (index, type) in zOrder.enumerated() {
            expr.append(type.rawValue)
            expr.append(index)
        }
        expr.append(-1)
        return expr
    }

    /// MapLibre expression for `fill-sort-key`/`line-sort-key`: the explicit
    /// per-feature `stackKey` (D23/D24 — server-assigned, course-group-then-
    /// hole-then-sort_order), falling back to the fixed type order for
    /// bundles generated before the stack model shipped (no `stackKey`
    /// property in their GeoJSON).
    public static func stackSortKeyExpression() -> [Any] {
        ["coalesce", ["get", "stackKey"], typeSortKeyExpression()]
    }
}
