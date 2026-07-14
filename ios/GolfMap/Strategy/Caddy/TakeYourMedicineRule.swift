import Foundation

/// take-your-medicine — "when you're in jail, punch out" (the Tiger 5 #4).
/// Faithful Swift port of `shared/strategy/caddy/rules/take-your-medicine.ts`.
/// On a RECOVERY leg the score-minimising play is the sideways/short punch that
/// gets the ball back onto short grass, not the hero shot. The rule quantifies
/// that with the expected-strokes table (no new math): it compares a MEDICINE
/// outcome (advance a modest fraction of the escape club, land in FAIRWAY) with
/// a HERO outcome (advance far but stay in a RECOVERY lie). When medicine
/// prices better it recommends the escape and vetoes any attack advice.
///
/// Pure/self-gating; conventions: meters, planar {x, y}, compass bearings. The
/// two MUST stay identical — ported tests + TS-generated goldens pin the parity.

/// Ids of the aggressive-line advice this rule demotes from a recovery lie.
public let MEDICINE_VETOES: [String] = ["par5-attack", "specific-target"]

/// Fraction of the escape club's carry a clean punch-out actually advances.
public let ESCAPE_ADVANCE_FRACTION = 0.6

/// Extra distance a HERO recovery attempt tries to advance over the safe
/// escape — priced as STILL in a recovery lie at the closer remaining distance.
public let HERO_EXTRA_ADVANCE_M = 60.0

/// Compass bearing (deg, 0 = north, cw) from `a` to `b` in planar meters.
private func medicineBearingDeg(_ a: Vec2, _ b: Vec2) -> Double {
    let deg = atan2(b.x - a.x, b.y - a.y) * 180 / .pi
    return (deg + 360).truncatingRemainder(dividingBy: 360)
}

private func medicineDistanceM(_ a: Vec2, _ b: Vec2) -> Double {
    hypot(b.x - a.x, b.y - a.y)
}

/// The shortest-carrying club in the bag — the natural punch-out escape.
private func escapeClub<Club: ClubSpec>(_ clubs: [Club]) -> Club? {
    var best: Club?
    for club in clubs where best == nil || club.carryM < best!.carryM { best = club }
    return best
}

/// The take-your-medicine rule as a value. Mirror of the TS `takeYourMedicineRule`.
public func takeYourMedicineRule<Club: ClubSpec>() -> CaddyRule<Club> {
    CaddyRule<Club>(
        id: "take-your-medicine",
        // Cheap gate: recovery legs only, and we need a club to escape with.
        appliesTo: { ctx in
            ctx.leg == .recovery && !ctx.clubs.isEmpty
        },
        evaluate: { ctx in
            let origin = Vec2(x: ctx.origin.x, y: ctx.origin.y)
            let center = ctx.target.center
            let remainingM = medicineDistanceM(origin, center)
            if remainingM <= 0 { return [] }

            guard let escape = escapeClub(ctx.clubs) else { return [] }

            let bearing = medicineBearingDeg(origin, center)
            let effect = ctx.wind.map { windEffect($0.speedMps, $0.directionDeg, bearing) } ?? 0

            // MEDICINE: a controlled punch-out lands back in the fairway.
            let escapeAdvanceM = min(
                remainingM,
                maxCarryM(escape.carryM, windEffect: effect) * ESCAPE_ADVANCE_FRACTION
            )
            let medicineRemainingM = max(0, remainingM - escapeAdvanceM)
            let medicineEv = 1 + shotsToHoleOut(medicineRemainingM, .fairway)

            // HERO: try to advance further but stay stuck in a recovery lie.
            let heroAdvanceM = min(remainingM, escapeAdvanceM + HERO_EXTRA_ADVANCE_M)
            let heroRemainingM = max(0, remainingM - heroAdvanceM)
            let heroEv = 1 + shotsToHoleOut(heroRemainingM, .recovery)

            // Only advise medicine when it actually prices better than forcing it.
            if medicineEv >= heroEv { return [] }

            let gap = heroEv - medicineEv
            let confidence = max(0.6, min(0.9, 0.6 + gap))
            let anchor = Vec2(
                x: origin.x + sin(bearing * .pi / 180) * escapeAdvanceM,
                y: origin.y + cos(bearing * .pi / 180) * escapeAdvanceM
            )

            let escapeName = escape.clubName ?? "\(String(format: "%.0f", escape.carryM)) m club"
            let detail = "Escaping to the fairway (~\(String(format: "%.0f", medicineRemainingM)) m left) "
                + "prices at \(String(format: "%.2f", medicineEv)) strokes; forcing it and staying stuck "
                + "prices at \(String(format: "%.2f", heroEv)). Give yourself a clean next shot."

            return [
                CaddyAdvice(
                    ruleId: "take-your-medicine",
                    kind: .layup,
                    priority: 4,
                    confidence: confidence,
                    headline: "Take your medicine — punch out with the \(escapeName) and get back in play.",
                    detail: detail,
                    anchor: anchor,
                    vetoes: MEDICINE_VETOES
                ),
            ]
        }
    )
}
