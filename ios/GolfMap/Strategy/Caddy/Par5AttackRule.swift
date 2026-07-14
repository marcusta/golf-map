import Foundation

/// par5-attack — the smart-caddy par-5 decision rule. Faithful Swift port of
/// `shared/strategy/caddy/rules/par5-attack.ts`. It compares the available
/// attack/lay-up choices with the locked two-shot EV chain: run optimizeAim for
/// THIS shot only, and price each sampled outcome with
/// `shotsToHoleOut(remaining, lie)`. No nested sampling; shot 2+ is the
/// expected-strokes table.
///
/// The rule synthesizes the narrow surface stack it needs for optimizeAim:
/// hazards first (already topmost-first), then the green polygon — preserving
/// D23's topmost-first truth where a greenside hazard overlaps the green.
///
/// Pure/self-gating; projected meters, compass bearings. The two MUST stay
/// identical — ported tests + TS-generated goldens pin the parity.

public let FULL_NUMBER_LAYUP_M = 100.0
public let LAY_BACK_OF_PINCH_BUFFER_M = 10.0
public let LAYUP_TARGET_TOLERANCE_M = 18.0

private enum Par5StrategyKind: String {
    case goInTwo = "go-in-2"
    case layUpToFullNumber = "lay-up-to-full-number"
    case layBackOfPinch = "lay-back-of-pinch"
}

private struct Par5Strategy<Club: ClubSpec> {
    var kind: Par5StrategyKind
    var club: Club
    var targetBearingDeg: Double
    var targetDistanceM: Double
    var plannedRemainingM: Double
    var fullNumberM: Double?
}

private struct ScoredPar5Strategy<Club: ClubSpec> {
    var strategy: Par5Strategy<Club>
    var aim: AimResult
    var ev: Double
}

/// Compass bearing (deg, 0 = north, cw) from `a` to `b` in planar meters.
private func par5BearingDeg(_ a: Vec2, _ b: Vec2) -> Double {
    let deg = atan2(b.x - a.x, b.y - a.y) * 180 / .pi
    return (deg + 360).truncatingRemainder(dividingBy: 360)
}

private func par5DistanceM(_ a: Vec2, _ b: Vec2) -> Double {
    hypot(b.x - a.x, b.y - a.y)
}

private func par5WindEffectFor<Club: ClubSpec>(_ ctx: CaddyContext<Club>, _ bearing: Double) -> Double {
    ctx.wind.map { windEffect($0.speedMps, $0.directionDeg, bearing) } ?? 0
}

private func par5ClubMaxCarryM<Club: ClubSpec>(_ club: Club, _ ctx: CaddyContext<Club>, _ bearing: Double) -> Double {
    maxCarryM(club.carryM, windEffect: par5WindEffectFor(ctx, bearing))
}

private func par5ClubName<Club: ClubSpec>(_ club: Club) -> String {
    club.clubName ?? "\(String(format: "%.0f", club.carryM)) m club"
}

/// Nearest-carry club within a tolerance of the target, else nil.
private func closestClubWithin<Club: ClubSpec>(
    _ clubs: [Club], _ targetDistanceM: Double, _ toleranceM: Double
) -> Club? {
    guard let club = closestClub(clubs, targetDistanceM) else { return nil }
    return abs(club.carryM - targetDistanceM) <= toleranceM ? club : nil
}

/// The best club that can REACH `remainingM` under wind (min |carry − remaining|
/// among clubs whose wind-adjusted max carry clears it).
private func bestReachClub<Club: ClubSpec>(
    _ ctx: CaddyContext<Club>, _ remainingM: Double, _ bearing: Double
) -> Club? {
    var best: Club?
    var bestDiff = Double.infinity
    for club in ctx.clubs {
        if par5ClubMaxCarryM(club, ctx, bearing) < remainingM { continue }
        let diff = abs(club.carryM - remainingM)
        if diff < bestDiff {
            best = club
            bestDiff = diff
        }
    }
    return best
}

/// Does the shot line clear every hazard that sits short of the target?
private func greenCarryClear<Club: ClubSpec>(
    _ ctx: CaddyContext<Club>, _ club: Club, _ bearing: Double, _ remainingM: Double
) -> Bool {
    let maxCarry = par5ClubMaxCarryM(club, ctx, bearing)
    let hits = hazardsAlongLine(Vec2(x: ctx.origin.x, y: ctx.origin.y), bearing, ctx.hazards)
    for hit in hits {
        if hit.frontM > remainingM { continue }
        if hit.carryM > maxCarry { return false }
    }
    return true
}

private func enumerateStrategies<Club: ClubSpec>(_ ctx: CaddyContext<Club>) -> [Par5Strategy<Club>] {
    let origin = Vec2(x: ctx.origin.x, y: ctx.origin.y)
    let remainingM = par5DistanceM(origin, ctx.target.center)
    let toGreenDeg = par5BearingDeg(origin, ctx.target.center)
    var strategies: [Par5Strategy<Club>] = []

    if let goClub = bestReachClub(ctx, remainingM, toGreenDeg),
       greenCarryClear(ctx, goClub, toGreenDeg, remainingM) {
        strategies.append(Par5Strategy(
            kind: .goInTwo,
            club: goClub,
            targetBearingDeg: toGreenDeg,
            targetDistanceM: remainingM,
            plannedRemainingM: 0,
            fullNumberM: nil
        ))
    }

    let fullTargetDistanceM = remainingM - FULL_NUMBER_LAYUP_M
    if fullTargetDistanceM > 0,
       let fullClub = closestClubWithin(ctx.clubs, fullTargetDistanceM, LAYUP_TARGET_TOLERANCE_M) {
        strategies.append(Par5Strategy(
            kind: .layUpToFullNumber,
            club: fullClub,
            targetBearingDeg: toGreenDeg,
            targetDistanceM: fullTargetDistanceM,
            plannedRemainingM: max(0, remainingM - fullClub.carryM),
            fullNumberM: FULL_NUMBER_LAYUP_M
        ))
    }

    let pinches = hazardsAlongLine(origin, toGreenDeg, ctx.hazards, maxM: remainingM)
        .filter { $0.frontM > LAY_BACK_OF_PINCH_BUFFER_M }
        .sorted { $0.frontM < $1.frontM }
    if let firstPinch = pinches.first {
        let layBackDistanceM = firstPinch.frontM - LAY_BACK_OF_PINCH_BUFFER_M
        if let layBackClub = closestClubWithin(ctx.clubs, layBackDistanceM, LAYUP_TARGET_TOLERANCE_M) {
            strategies.append(Par5Strategy(
                kind: .layBackOfPinch,
                club: layBackClub,
                targetBearingDeg: toGreenDeg,
                targetDistanceM: layBackDistanceM,
                plannedRemainingM: max(0, remainingM - layBackClub.carryM),
                fullNumberM: nil
            ))
        }
    }

    return strategies
}

private func scoreStrategies<Club: ClubSpec>(_ ctx: CaddyContext<Club>) -> [ScoredPar5Strategy<Club>] {
    let surfaces = ctx.hazards + [ctx.target.greenPoly]
    return enumerateStrategies(ctx).map { strategy -> ScoredPar5Strategy<Club> in
        let aim = optimizeAim(AimOptions(
            origin: Vec2(x: ctx.origin.x, y: ctx.origin.y),
            club: strategy.club,
            targetBearingDeg: strategy.targetBearingDeg,
            surfaces: surfaces,
            greenCenter: ctx.target.center,
            windSpeedMps: ctx.wind?.speedMps,
            windDirectionDeg: ctx.wind?.directionDeg,
            riskAversion: ctx.risk.riskAversion,
            fallbackLie: .fairway
        ))
        return ScoredPar5Strategy(strategy: strategy, aim: aim, ev: aim.best.score)
    }.sorted { $0.ev < $1.ev }
}

private func confidenceFromGap<Club: ClubSpec>(
    _ best: ScoredPar5Strategy<Club>, _ next: ScoredPar5Strategy<Club>?
) -> Double {
    guard let next else { return 0.6 }
    let gap = next.ev - best.ev
    return max(0.55, min(0.95, 0.55 + gap))
}

private func fullNumberHeadline<Club: ClubSpec>(
    _ best: ScoredPar5Strategy<Club>, _ others: [ScoredPar5Strategy<Club>]
) -> String {
    let fullNumber = best.strategy.fullNumberM.map { String(format: "%.0f", $0) }
        ?? "\(Int(FULL_NUMBER_LAYUP_M))"
    let awkward = others
        .filter { $0.strategy.plannedRemainingM > 0 && $0.strategy.plannedRemainingM < FULL_NUMBER_LAYUP_M }
        .sorted { $0.strategy.plannedRemainingM < $1.strategy.plannedRemainingM }
        .first
    if let awkward {
        return "Lay up to a full \(fullNumber) m wedge — "
            + "a \(String(format: "%.0f", awkward.strategy.plannedRemainingM)) m leftover prices worse."
    }
    return "Lay up to a full \(fullNumber) m wedge."
}

private func headlineFor<Club: ClubSpec>(
    _ best: ScoredPar5Strategy<Club>, _ others: [ScoredPar5Strategy<Club>]
) -> String {
    switch best.strategy.kind {
    case .goInTwo:
        return "Attack the green in two — \(par5ClubName(best.strategy.club)) reaches and the carry is clear."
    case .layUpToFullNumber:
        return fullNumberHeadline(best, others)
    case .layBackOfPinch:
        return "Lay back of the pinch — \(par5ClubName(best.strategy.club)) leaves about "
            + "\(String(format: "%.0f", best.strategy.plannedRemainingM)) m."
    }
}

private func detailFor<Club: ClubSpec>(
    _ best: ScoredPar5Strategy<Club>, _ next: ScoredPar5Strategy<Club>?
) -> String {
    let base = "\(par5ClubName(best.strategy.club)) at "
        + "\(String(format: "%.0f", best.strategy.targetDistanceM)) m prices at "
        + "\(String(format: "%.2f", best.ev)) expected strokes."
    guard let next else { return base }
    return "\(base) Next best was \(next.strategy.kind.rawValue) at \(String(format: "%.2f", next.ev))."
}

/// The par5-attack rule as a value. Mirror of the TS `par5AttackRule`.
public func par5AttackRule<Club: ClubSpec>() -> CaddyRule<Club> {
    CaddyRule<Club>(
        id: "par5-attack",
        appliesTo: { ctx in
            ctx.hole.par == 5 && (ctx.leg == .tee || ctx.leg == .layup)
        },
        evaluate: { ctx in
            let ranked = scoreStrategies(ctx)
            guard let best = ranked.first else { return [] }
            let next = ranked.count > 1 ? ranked[1] : nil

            let anchor: Vec2
            if best.strategy.kind == .goInTwo {
                anchor = ctx.target.center
            } else {
                anchor = Vec2(
                    x: ctx.origin.x + sin(best.strategy.targetBearingDeg * .pi / 180) * best.strategy.targetDistanceM,
                    y: ctx.origin.y + cos(best.strategy.targetBearingDeg * .pi / 180) * best.strategy.targetDistanceM
                )
            }

            return [
                CaddyAdvice(
                    ruleId: "par5-attack",
                    kind: best.strategy.kind == .goInTwo ? .aim : .layup,
                    priority: 3,
                    confidence: confidenceFromGap(best, next),
                    headline: headlineFor(best, Array(ranked.dropFirst())),
                    detail: detailFor(best, next),
                    anchor: anchor
                ),
            ]
        }
    )
}
