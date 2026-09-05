import Foundation

/// Default apex (peak ball height) by carry distance — faithful Swift port of
/// `shared/strategy/apex.ts`. The two MUST stay numerically identical (ported
/// tests pin the parity). Feeds `treeClearance` when there is no trajectory
/// sampler.
///
/// Table source: TrackMan PGA Tour averages (carry in yards / apex in feet,
/// converted to meters and rounded): driver ~250 m / 31 m, 3-wood ~222 m /
/// 28 m, 5-iron ~177 m / 31 m, 7-iron ~157 m / 27 m, 9-iron ~135 m / 27 m,
/// PW ~124 m / 24 m. Tour irons peak around 30 m across the bag; only the
/// short game drops sharply. The anchors bracket the distances a planner sees
/// (driver 230 m down to a 50 m pitch), linearly interpolated, clamped at the
/// ends. Amateurs launch slower and spin less, so `apexScale` (default
/// `AMATEUR_APEX_SCALE` = 0.85) scales the whole table; pass 1 for tour numbers.
public enum Apex {

    public struct Anchor: Equatable, Sendable {
        public var carryM: Double
        public var apexM: Double
    }

    /// Carry → apex anchors, meters, ascending carry. Mirror of `APEX_TABLE`.
    public static let table: [Anchor] = [
        Anchor(carryM: 50, apexM: 12),
        Anchor(carryM: 90, apexM: 22),
        Anchor(carryM: 120, apexM: 26),
        Anchor(carryM: 150, apexM: 28),
        Anchor(carryM: 200, apexM: 30),
        Anchor(carryM: 230, apexM: 30),
    ]

    /// Amateur apex as a fraction of the tour table. Mirror of `AMATEUR_APEX_SCALE`.
    public static let amateurApexScale = 0.85

    /// Optional club hints; a measured `apexM` on the club wins over the table.
    /// Mirror of `ApexClubHint`.
    public struct ClubHint: Equatable, Sendable {
        public var category: String?
        public var loftDeg: Double?
        /// Measured/known apex for this club, meters — used verbatim when finite and > 0.
        public var apexM: Double?

        public init(category: String? = nil, loftDeg: Double? = nil, apexM: Double? = nil) {
            self.category = category
            self.loftDeg = loftDeg
            self.apexM = apexM
        }
    }

    /// Tour-table apex for `carryM` (meters), linearly interpolated, clamped at
    /// the ends. 0 for a non-positive / non-finite carry. Mirror of `tableApexM`.
    public static func tableApexM(_ carryM: Double) -> Double {
        guard carryM > 0 else { return 0 } // also false for NaN
        let first = table[0]
        let last = table[table.count - 1]
        if carryM <= first.carryM { return first.apexM }
        if carryM >= last.carryM { return last.apexM }
        for i in 0..<(table.count - 1) {
            let a = table[i]
            let b = table[i + 1]
            if carryM >= a.carryM && carryM <= b.carryM {
                let t = (carryM - a.carryM) / (b.carryM - a.carryM)
                return a.apexM + (b.apexM - a.apexM) * t
            }
        }
        return last.apexM
    }

    /// Apex height above the origin's ground for a shot carrying `carryM`,
    /// meters. A club with a measured `apexM` is used as-is; otherwise the tour
    /// table scaled by `apexScale`. `category`/`loftDeg` are accepted for future
    /// refinement and currently do not change the result. Mirror of `apexHeightM`.
    public static func apexHeightM(
        _ carryM: Double,
        club: ClubHint? = nil,
        apexScale: Double = amateurApexScale
    ) -> Double {
        if let measured = club?.apexM, measured.isFinite, measured > 0 { return measured }
        return tableApexM(carryM) * apexScale
    }
}
