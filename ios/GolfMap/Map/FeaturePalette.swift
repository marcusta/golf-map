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
    case water
    case waterCreek = "water_creek"
    case path
    case outside

    /// Semi-transparent fill color (opacity applied via `fill-opacity`).
    public var fillHex: String {
        switch self {
        case .green: "#8fe0a0"
        case .tee: "#63b578"
        case .fairway: "#4d9e58"
        case .semiRough: "#79a860"
        case .rough: "#55803f"
        case .deepRough: "#3c5c2e"
        case .bunker: "#e9d8a0"
        case .water: "#4f8fd0"
        case .waterCreek: "#6fb1e0"
        case .path: "#b6a68d"
        case .outside: "#9097a0"
        }
    }

    /// Full-strength outline color.
    public var outlineHex: String {
        switch self {
        case .green: "#4fa863"
        case .tee: "#3c8a52"
        case .fairway: "#2f7d43"
        case .semiRough: "#557f41"
        case .rough: "#3b5f2b"
        case .deepRough: "#294420"
        case .bunker: "#c4a95e"
        case .water: "#2f6aa8"
        case .waterCreek: "#4585b8"
        case .path: "#8f7f66"
        case .outside: "#6a7178"
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
        .tee, .green, .bunker, .water, .waterCreek, .path,
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
