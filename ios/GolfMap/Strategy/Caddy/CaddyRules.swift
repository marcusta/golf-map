import Foundation

/// The full, ordered smart-caddy rule set — the Swift mirror of the web
/// planner's `CADDY_RULES` (`web/src/planner/planner-tool.service.ts`). The
/// evaluator (`runCaddy`) self-gates each rule, so the whole set is run over
/// every leg context and the order only affects deterministic tie-breaks.
///
/// Kept as a factory function (not a stored constant) because each rule is a
/// generic `CaddyRule<Club>` value that must be specialised to the caller's
/// concrete `ClubSpec` (the on-course screen passes `ClubRecord`).
public func caddyRules<Club: ClubSpec>() -> [CaddyRule<Club>] {
    [
        greenSlopeHalfRule(),
        par5AttackRule(),
        shortSideGuardRule(),
        noDoublesRule(),
        takeYourMedicineRule(),
        specificTargetRule(),
    ]
}
