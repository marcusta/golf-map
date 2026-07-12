import Foundation

/// Player-facing distance unit preference (Settings § distance units). ALL
/// distance math throughout the app stays metric internally — planar
/// EPSG:3006 meters (`Distance.planarMeters`, `PlaysLike`, `OnCourseDistances`,
/// `HazardCarries`, …). This is a DISPLAY-ONLY conversion applied at format
/// time by `DistanceFormat`; nothing upstream of a view ever computes in
/// yards.
///
/// Elevation deltas and slope % are NOT distances in this sense — golf
/// convention keeps them metric/percent regardless of the unit setting (see
/// `DistanceFormat` doc). Putt lengths in the green-read panel keep their own
/// existing meters/paces convention (unaffected by this setting).
enum DistanceUnit: String, CaseIterable, Identifiable, Codable, Sendable {
    case meters
    case yards

    var id: String { rawValue }
    var label: String { self == .meters ? "Meters" : "Yards" }
    /// Dimmed unit suffix for `MetricText`/`MapLabelPill`.
    var abbreviation: String { self == .meters ? "m" : "yd" }
}

/// Central meters → display-unit formatter. Whole units both ways — an
/// on-course figure is never fractional, in either meters or yards (matching
/// the existing whole-meter convention everywhere distances are shown).
///
/// Call this at the view layer only. Every model/service keeps computing and
/// storing meters; converting earlier would leak the display preference into
/// geometry, persistence, or debug/live-verify hooks that assume meters.
enum DistanceFormat {
    /// International yard, exact.
    static let metersPerYard = 0.9144

    /// Rounds meters to the nearest whole display unit.
    static func wholeUnits(_ meters: Double, unit: DistanceUnit) -> Int {
        switch unit {
        case .meters: return Int(meters.rounded())
        case .yards: return Int((meters / metersPerYard).rounded())
        }
    }

    static func wholeUnits(_ meters: Int, unit: DistanceUnit) -> Int {
        wholeUnits(Double(meters), unit: unit)
    }

    /// "182" — bare number, no unit suffix. Pair with `unit.abbreviation`
    /// (e.g. via `MetricText`'s dimmed unit slot).
    static func string(_ meters: Double, unit: DistanceUnit) -> String {
        String(wholeUnits(meters, unit: unit))
    }

    static func string(_ meters: Int, unit: DistanceUnit) -> String {
        string(Double(meters), unit: unit)
    }

    /// Nil-safe — "–" for missing data, matching the existing on-course
    /// convention (`OnCourseDistances`' optional meters fields).
    static func string(_ meters: Int?, unit: DistanceUnit) -> String {
        guard let meters else { return "–" }
        return string(meters, unit: unit)
    }

    static func string(_ meters: Double?, unit: DistanceUnit) -> String {
        guard let meters else { return "–" }
        return string(meters, unit: unit)
    }

    /// "182 m" / "199 yd" — combined string for plain `Text` call sites that
    /// aren't using `MetricText`'s split value/unit rendering.
    static func stringWithUnit(_ meters: Int?, unit: DistanceUnit) -> String {
        guard let meters else { return "–" }
        return "\(string(meters, unit: unit)) \(unit.abbreviation)"
    }

    static func stringWithUnit(_ meters: Double?, unit: DistanceUnit) -> String {
        guard let meters else { return "–" }
        return "\(string(meters, unit: unit)) \(unit.abbreviation)"
    }
}
