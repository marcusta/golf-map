import Foundation

/// specific-target — "commit to a specific target and the club to match it"
/// (the Tiger 5 #5). Faithful Swift port of
/// `shared/strategy/caddy/rules/specific-target.ts`. On any approach it turns
/// the aim optimiser's continuous output into the single sentence a caddy says:
/// aim HERE, hit THIS club. It reads the recommended aim bearing
/// (`aim.bestBearingDeg`) and the plays-like distance to the green, then names
/// the front/centre/back club fit via `clubAdvice`.
///
/// This is the AGGRESSIVE-line advice: the safety rules (no-doubles,
/// short-side-guard, take-your-medicine) carry vetoes against THIS rule's id.
///
/// Pure/self-gating. The two MUST stay identical — ported tests + TS-generated
/// goldens pin the parity.
///
/// One deliberate deviation from the TS: `fit.front !== fit.back` is a
/// reference-identity check in JS; on Swift value types we compare `carryM`,
/// which is equivalent for any bag of distinct-carry clubs (front reaches, back
/// stays short, so their carries differ unless a single club sits exactly on
/// the number, where both slots are that club).

private func specificTargetDistanceM(_ a: Vec2, _ b: Vec2) -> Double {
    hypot(b.x - a.x, b.y - a.y)
}

private func specificTargetClubName<Club: ClubSpec>(_ club: Club) -> String {
    club.clubName ?? "\(String(format: "%.0f", club.carryM)) m club"
}

/// How confident we are the recommended aim is worth committing to: the cleaner
/// the pattern holds the green, the surer the target. Kept in [0.5, 0.9].
private func specificTargetConfidence(_ aim: AimResult) -> Double {
    let held = aim.breakdown[.green] ?? 0
    return 0.5 + 0.4 * min(1, held)
}

/// The specific-target rule as a value. Mirror of the TS `specificTargetRule`.
public func specificTargetRule<Club: ClubSpec>() -> CaddyRule<Club> {
    CaddyRule<Club>(
        id: "specific-target",
        // Cheap gate: approaches only, needs an aim result to name a target.
        appliesTo: { ctx in
            ctx.leg == .approach && ctx.aim != nil
        },
        evaluate: { ctx in
            guard let aim = ctx.aim else { return [] }
            let origin = Vec2(x: ctx.origin.x, y: ctx.origin.y)
            let distToGreenM = specificTargetDistanceM(origin, ctx.target.center)

            // The committed landing point: project the recommended bearing
            // forward by the distance to the green centre.
            let unit = bearingToUnitVector(aim.bestBearingDeg)
            let anchor = Vec2(
                x: origin.x + unit.x * distToGreenM,
                y: origin.y + unit.y * distToGreenM
            )

            // Club fit for the number — front / centre / back.
            let fit = ctx.clubs.isEmpty ? nil : clubAdvice(ctx.clubs, distToGreenM)
            let centre = fit?.center

            let headline = centre.map {
                "Commit to a target — aim your \(specificTargetClubName($0)) at the recommended line."
            } ?? "Commit to a target — aim at the recommended line and swing freely."

            var detail = "The aim optimiser likes a \(String(format: "%.0f", aim.bestBearingDeg))° "
                + "line to about \(String(format: "%.0f", distToGreenM)) m."
            if let centre {
                detail += " The \(specificTargetClubName(centre)) is the number"
                if let front = fit?.front, let back = fit?.back, front.carryM != back.carryM {
                    detail += " (\(specificTargetClubName(back)) back, \(specificTargetClubName(front)) front)"
                }
                detail += ". Pick the target, then swing."
            }

            return [
                CaddyAdvice(
                    ruleId: "specific-target",
                    kind: .aim,
                    priority: 2,
                    confidence: specificTargetConfidence(aim),
                    headline: headline,
                    detail: detail,
                    anchor: anchor
                ),
            ]
        }
    )
}
