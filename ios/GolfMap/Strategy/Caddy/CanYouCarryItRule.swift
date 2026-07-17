import Foundation

/// can-you-carry-it — "can't carry the bunker under a 6i — lay up / club up"
/// (feature-smart-caddy.md §5). Faithful Swift port of
/// `shared/strategy/caddy/rules/can-you-carry-it.ts`. For any hazard the shot
/// line crosses, it compares where the intended club actually lands (the
/// ±5%-banded, wind-adjusted carry window) against the hazard's near/far edges
/// (`hazardsAlongLine`). When the landing window overlaps the hazard, it names
/// the fix: CLUB UP to the shortest club whose short miss still clears the far
/// edge, or LAY UP with the longest club whose long miss stays short of the
/// near edge.
///
/// Pure/self-gating; conventions: meters, planar {x, y}, compass bearings. The
/// two MUST stay identical — ported tests + TS-generated goldens pin the parity.

/// How far past the target a club-up club may land before "club up" stops
/// being the fix (a carrying club that flies 40 m over the green is not
/// advice). Within this the classic "take one more club over the front
/// bunker" holds; beyond it the rule recommends laying up instead.
public let CLUB_UP_MAX_PAST_TARGET_M = 20.0

/// Compass bearing (deg, 0 = north, cw) from `a` to `b` in planar meters.
private func carryBearingDeg(_ a: Vec2, _ b: Vec2) -> Double {
    let deg = atan2(b.x - a.x, b.y - a.y) * 180 / .pi
    return (deg + 360).truncatingRemainder(dividingBy: 360)
}

private func carryDistanceM(_ a: Vec2, _ b: Vec2) -> Double {
    hypot(b.x - a.x, b.y - a.y)
}

private func carryClubName<Club: ClubSpec>(_ club: Club) -> String {
    club.clubName ?? "\(String(format: "%.0f", club.carryM)) m club"
}

/// The club nearest `distanceM` by nominal carry (earlier club wins ties).
private func carryClosestClub<Club: ClubSpec>(_ clubs: [Club], _ distanceM: Double) -> Club? {
    var best: Club?
    var bestDiff = Double.infinity
    for club in clubs {
        let diff = abs(club.carryM - distanceM)
        if diff < bestDiff {
            best = club
            bestDiff = diff
        }
    }
    return best
}

/// The can-you-carry-it rule as a value. Mirror of the TS `canYouCarryItRule`.
public func canYouCarryItRule<Club: ClubSpec>() -> CaddyRule<Club> {
    CaddyRule<Club>(
        id: "can-you-carry-it",
        // Cheap gate: needs a club to fly and a hazard to cross.
        appliesTo: { ctx in
            !ctx.clubs.isEmpty && !ctx.hazards.isEmpty
        },
        evaluate: { ctx in
            let origin = Vec2(x: ctx.origin.x, y: ctx.origin.y)
            let center = ctx.target.center
            let remainingM = carryDistanceM(origin, center)
            if remainingM <= 0 { return [] }

            // The shot line: the recommended aim when priced, else straight at
            // the target centre.
            let bearing = ctx.aim?.bestBearingDeg ?? carryBearingDeg(origin, center)

            // The club being hit: nearest nominal carry to the intended shot
            // distance (the remaining distance, capped at the longest club).
            var longestM = 0.0
            for club in ctx.clubs { longestM = max(longestM, club.carryM) }
            guard let shotClub = carryClosestClub(ctx.clubs, min(remainingM, longestM))
            else { return [] }

            // Wind is a forward application on each club's own nominal carry
            // (same convention as par5-attack / take-your-medicine).
            func band(for club: Club) -> (minM: Double, maxM: Double) {
                let effect = ctx.wind.map {
                    windEffect($0.speedMps, $0.directionDeg, bearing, club.carryM)
                } ?? 0
                return (
                    minM: minCarryM(club.carryM, windEffect: effect),
                    maxM: maxCarryM(club.carryM, windEffect: effect)
                )
            }

            let shotBand = band(for: shotClub)
            if shotBand.maxM <= shotBand.minM { return [] }

            // The hazard the shot flirts with most: the crossed ring whose
            // [front, carry] interval overlaps the largest share of the club's
            // landing window. Strictly-greater keeps ties on the earlier ring
            // (deterministic — hazardsAlongLine preserves input order).
            let hits = hazardsAlongLine(origin, bearing, ctx.hazards)
            var threatened: CarryOverHazard?
            var bestShare = 0.0
            for hit in hits {
                let overlapM = min(shotBand.maxM, hit.carryM) - max(shotBand.minM, hit.frontM)
                let share = overlapM / (shotBand.maxM - shotBand.minM)
                if share > bestShare {
                    bestShare = share
                    threatened = hit
                }
            }
            guard let threatened else { return [] }
            let share = min(1, bestShare)

            // Remedies, each judged on its own wind-adjusted band.
            var clubUp: Club?
            var layUp: Club?
            for club in ctx.clubs {
                let b = band(for: club)
                if b.minM > threatened.carryM && (clubUp == nil || club.carryM < clubUp!.carryM) {
                    clubUp = club
                }
                if b.maxM < threatened.frontM && (layUp == nil || club.carryM > layUp!.carryM) {
                    layUp = club
                }
            }
            let canClubUp = clubUp != nil
                && clubUp!.carryM - remainingM <= CLUB_UP_MAX_PAST_TARGET_M

            let label = threatened.ring.kind
            let along = Vec2(x: sin(bearing * .pi / 180), y: cos(bearing * .pi / 180))

            let kind: CaddyAdviceKind
            let headline: String
            let anchorM: Double
            if canClubUp {
                kind = .club
                headline = "Can't carry the \(label) with the \(carryClubName(shotClub)) — "
                    + "club up to the \(carryClubName(clubUp!))."
                anchorM = threatened.carryM
            } else if let layUp {
                kind = .layup
                headline = "Can't carry the \(label) with the \(carryClubName(shotClub)) — "
                    + "lay up short with the \(carryClubName(layUp))."
                anchorM = threatened.frontM
            } else {
                kind = .warning
                headline = "The \(label) at \(String(format: "%.0f", threatened.carryM)) m is in play "
                    + "with the \(carryClubName(shotClub))."
                anchorM = threatened.carryM
            }

            // Priority: a penalty hazard (water/OOB) outranks sand/rough trouble.
            let priority: Double = lieFromFeatureType(threatened.ring.kind) == .penalty ? 4 : 3
            // Confidence grows with how much of the landing window the hazard
            // eats — a sliver is a soft note, half the pattern is near-certain.
            let confidence = min(0.9, 0.55 + 0.35 * share)

            let detail = "The \(label) runs \(String(format: "%.0f", threatened.frontM))–"
                + "\(String(format: "%.0f", threatened.carryM)) m on this line; "
                + "the \(carryClubName(shotClub)) lands \(String(format: "%.0f", shotBand.minM))–"
                + "\(String(format: "%.0f", shotBand.maxM)) m."

            return [
                CaddyAdvice(
                    ruleId: "can-you-carry-it",
                    kind: kind,
                    priority: priority,
                    confidence: confidence,
                    headline: headline,
                    detail: detail,
                    anchor: Vec2(x: origin.x + along.x * anchorM, y: origin.y + along.y * anchorM),
                    riskWeighted: true
                ),
            ]
        }
    )
}
