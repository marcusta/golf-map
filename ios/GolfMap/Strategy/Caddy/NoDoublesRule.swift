import Foundation

/// no-doubles — the "bogey is fine, doubles kill you" safety rule (the Tiger 5
/// #1). Faithful Swift port of `shared/strategy/caddy/rules/no-doubles.ts`. It
/// never invents its own risk math: the aim optimiser already computes, for the
/// recommended aim, both the mean (`expectedStrokes`) and the CVaR₈₀ tail
/// (`tailStrokes`). When the tail runs a long way past the mean the aggressive
/// line carries a blow-up you should not accept, so the rule warns and VETOES
/// the aggressive attack/aim advice.
///
/// Pure/self-gating; reads only `ctx.aim`. The two MUST stay identical — ported
/// tests + TS-generated goldens pin the parity.

/// Ids of the aggressive-line advice this rule demotes when the tail is ugly.
public let NO_DOUBLES_VETOES: [String] = ["par5-attack", "specific-target"]

/// Tail gap (strokes) above which the disaster miss is worth a warning.
public let TAIL_GAP_WARN = 0.5

/// Tail gap at which the concern is at full strength (priority saturates).
public let TAIL_GAP_SEVERE = 1.5

/// The recommended aim's tail gap (tail − mean), or nil when unavailable.
private func tailGap(_ aim: AimResult) -> Double? {
    let gap = aim.best.tailStrokes - aim.best.expectedStrokes
    return gap.isFinite ? gap : nil
}

/// The no-doubles rule as a value. Mirror of the TS `noDoublesRule`.
public func noDoublesRule<Club: ClubSpec>() -> CaddyRule<Club> {
    CaddyRule<Club>(
        id: "no-doubles",
        // Cheap gate: needs a full-shot aim result to read the tail from. Any
        // non-recovery leg with an AimResult qualifies.
        appliesTo: { ctx in
            ctx.leg != .recovery && ctx.aim != nil
        },
        evaluate: { ctx in
            guard let aim = ctx.aim, let gap = tailGap(aim), gap >= TAIL_GAP_WARN else { return [] }

            // Ramp priority from ~2 (marginal) to ~4 (severe) across the band.
            let t = min(1, (gap - TAIL_GAP_WARN) / (TAIL_GAP_SEVERE - TAIL_GAP_WARN))
            let priority = 2 + 2 * t
            // Confidence grows with the gap too, kept in [0.6, 0.95].
            let confidence = 0.6 + 0.35 * t

            let detail = "The aggressive aim's bad-miss tail costs about "
                + "\(String(format: "%.1f", gap)) strokes more than its average — a bogey here is "
                + "fine, a double is not. Favour the fat, trouble-free side."

            return [
                CaddyAdvice(
                    ruleId: "no-doubles",
                    kind: .warning,
                    priority: priority,
                    confidence: confidence,
                    headline: "Protect against the big number — take the safe line.",
                    detail: detail,
                    vetoes: NO_DOUBLES_VETOES,
                    riskWeighted: true
                ),
            ]
        }
    )
}
