import Foundation

/// Along-line hazard front/carry distances for the on-course distance card
/// (Part A). Pure planar composition over `hazardsAlongLine` (Carry.swift):
/// project the primary shot line (origin → the routed aim or green center),
/// find the hazard rings the line crosses, and expand each into a compact
/// front/carry row — matching the web semantics (decision D5: only hazards the
/// line crosses; near-edge = front, far-edge = carry).
///
/// These are RAW line distances: plays-like / wind adjustments are NOT applied
/// (same as the web). They are straight measured distances, so they are shown
/// even in competition mode (the DMD rule allows distance).
///
/// Units: planar EPSG:3006 meters {x east, y north}; compass bearings.

/// One hazard the shot line crosses, as whole-meter front/carry distances.
public struct HazardCarry: Equatable, Identifiable, Sendable {
    /// Display label for the hazard type, e.g. "Bunker", "Water".
    public var label: String
    /// The raw feature type ("bunker", "water", …), for styling.
    public var kind: String
    /// Near-edge distance along the shot line, whole meters.
    public var frontM: Int
    /// Far-edge distance along the shot line, whole meters.
    public var carryM: Int

    public var id: String { "\(kind)-\(frontM)-\(carryM)" }

    public init(label: String, kind: String, frontM: Int, carryM: Int) {
        self.label = label
        self.kind = kind
        self.frontM = frontM
        self.carryM = carryM
    }
}

public enum HazardCarries {

    /// Feature types shown as carry hazards on the card — the physical /
    /// penalty carries a player reads off the line (subset of the strategy
    /// `DEFAULT_HAZARD_TYPES`; ground types like deep_rough/trees are omitted so
    /// the card stays about true carries).
    public static let displayedTypes: Set<String> = [
        "bunker", "water", "water_creek", "penalty_yellow", "penalty_red",
    ]

    /// Human label for a feature type (unknown types Title-Cased as a fallback).
    public static func label(for kind: String) -> String {
        switch kind {
        case "bunker": return "Bunker"
        case "water": return "Water"
        case "water_creek": return "Creek"
        case "penalty_yellow", "penalty_red": return "Penalty"
        default:
            return kind
                .split(separator: "_")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// Hazard front/carry rows along the line origin → target, sorted by front
    /// distance and capped to the `cap` nearest ahead. Only rings the ray
    /// actually crosses within the target distance are returned (a hazard past
    /// the target is not a carry to reach it). Pure planar — the model converts
    /// WGS84 → EPSG before calling.
    ///
    /// - Parameters:
    ///   - origin: shot origin, EPSG:3006.
    ///   - target: the primary target the card measures to, EPSG:3006.
    ///   - hazards: candidate hazard rings (already flattened / filtered).
    ///   - cap: max rows to return (2–3 nearest). Default 3.
    public static func along(
        origin: Vec2,
        target: Vec2,
        hazards: [FlatRing],
        cap: Int = 3
    ) -> [HazardCarry] {
        guard !hazards.isEmpty else { return [] }
        let dx = target.x - origin.x
        let dy = target.y - origin.y
        let distanceM = hypot(dx, dy)
        guard distanceM > 0 else { return [] }

        let deg = atan2(dx, dy) * 180 / .pi
        let bearingDeg = deg < 0 ? deg + 360 : deg

        let hits = hazardsAlongLine(origin, bearingDeg, hazards, maxM: distanceM)
        return hits
            .sorted {
                $0.frontM != $1.frontM ? $0.frontM < $1.frontM : $0.carryM < $1.carryM
            }
            .prefix(cap)
            .map {
                HazardCarry(
                    label: label(for: $0.ring.kind),
                    kind: $0.ring.kind,
                    frontM: Int($0.frontM.rounded()),
                    carryM: Int($0.carryM.rounded())
                )
            }
    }
}
