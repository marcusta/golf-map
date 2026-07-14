import Foundation

/// short-side-guard — "never short-side yourself" (the Tiger 5 #3). Faithful
/// Swift port of `shared/strategy/caddy/rules/short-side-guard.ts`. On an
/// approach whose dispersion pattern spills a meaningful share into trouble
/// (sand / water / recovery), firing straight at the pin risks the short-side
/// miss. The fix is to aim at the FAT side of the pin. It reads the recommended
/// aim's lie breakdown (`aim.breakdown`) — the trouble share IS the short-side
/// risk proxy — and vetoes the aggressive attack/aim advice when it is high.
///
/// Pure/self-gating. The two MUST stay identical — ported tests + TS-generated
/// goldens pin the parity.

/// Ids of the aggressive-line advice this rule demotes on a short-side risk.
public let SHORT_SIDE_VETOES: [String] = ["par5-attack", "specific-target"]

/// Trouble share (sand + water/penalty + recovery fraction of the pattern)
/// above which the short-side risk is real enough to speak up. ~8%.
public let SHORT_SIDE_TROUBLE_SHARE = 0.08

/// Trouble share at which the concern saturates (priority + confidence max out).
public let SHORT_SIDE_TROUBLE_SEVERE = 0.25

/// Combined trouble share of an aim's lie breakdown (sand+penalty+recovery).
private func troubleShare(_ aim: AimResult) -> Double {
    let b = aim.breakdown
    return (b[.sand] ?? 0) + (b[.penalty] ?? 0) + (b[.recovery] ?? 0)
}

/// The short-side-guard rule as a value. Mirror of the TS `shortSideGuardRule`.
public func shortSideGuardRule<Club: ClubSpec>() -> CaddyRule<Club> {
    CaddyRule<Club>(
        id: "short-side-guard",
        // Cheap gate: approaches only, needs an aim result, and there must be at
        // least one hazard on the hole for a short-side to exist at all.
        appliesTo: { ctx in
            ctx.leg == .approach && ctx.aim != nil && !ctx.hazards.isEmpty
        },
        evaluate: { ctx in
            guard let aim = ctx.aim else { return [] }
            let share = troubleShare(aim)
            if share < SHORT_SIDE_TROUBLE_SHARE { return [] }

            let t = min(
                1,
                (share - SHORT_SIDE_TROUBLE_SHARE) / (SHORT_SIDE_TROUBLE_SEVERE - SHORT_SIDE_TROUBLE_SHARE)
            )
            let priority = 2.5 + 1.5 * t // ramps 2.5 → 4
            let confidence = 0.6 + 0.3 * t // ramps 0.6 → 0.9
            let pct = Int((share * 100).rounded())

            let detail = "About \(pct)% of this shot's pattern finds sand, water, or a recovery lie "
                + "around the green. Favour the side with the most green to work with, so the same "
                + "miss still leaves a straightforward up-and-down."

            return [
                CaddyAdvice(
                    ruleId: "short-side-guard",
                    kind: .aim,
                    priority: priority,
                    confidence: confidence,
                    headline: "Aim to the fat side of the pin — don’t short-side yourself.",
                    detail: detail,
                    anchor: ctx.target.center,
                    vetoes: SHORT_SIDE_VETOES,
                    riskWeighted: true
                ),
            ]
        }
    )
}
