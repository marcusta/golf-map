import Foundation

/// THE one formatter for the R4 score/risk triple — probable hole score,
/// penalty probability, and the CVaR₈₀ blow-up score where it changes the
/// call. Decide choices (T33) and authored option chips (T32) MUST both speak
/// through this so the two surfaces use identical vocabulary (options doc O4:
/// "prob. 4.1 · 1% pen" / "prob. 3.9 · 18% pen, blow-up 5.6").
enum ScoreRiskFormat {

    /// "prob. 4.1 · 1% pen", plus ", blow-up 5.6" when `tailScore` is present
    /// (the caller only passes a tail where it changes the call — the
    /// no-doubles `TAIL_GAP_WARN` gate).
    static func triple(probableScore: Double, penaltyShare: Double, tailScore: Double?) -> String {
        var out = "prob. \(score(probableScore)) · \(penaltyPct(penaltyShare))% pen"
        if let tailScore {
            out += ", blow-up \(score(tailScore))"
        }
        return out
    }

    /// One-decimal score figure ("4.1").
    static func score(_ value: Double) -> String {
        String(format: "%.1f", value)
    }

    /// Whole-percent penalty figure from a 0..1 share ("18").
    static func penaltyPct(_ share: Double) -> Int {
        Int((share * 100).rounded())
    }
}
