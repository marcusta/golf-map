import Foundation

/// green-slope-half — the marquee caddy rule. Faithful Swift port of
/// `shared/strategy/caddy/rules/green-slope-half.ts`. On an approach to a green
/// that falls back-to-front steeply enough, and where the front approach is
/// clean, it tells the player to favour the SHORT half. Pure and self-gating; it
/// reads only a `GreenSlopeSummary` (the platform adapter over the slope grid)
/// and the hole's hazard rings. The two MUST stay identical: ported tests +
/// TS-generated golden fixtures pin the parity.
///
/// Conventions (mirror the whole library): meters; planar {x east, y north};
/// compass bearings (0 = north, clockwise).

/// Minimum dominant fall-line magnitude (%) for the rule to fire. Below this a
/// back-to-front tilt is not decisive enough to change where you aim.
public let MIN_FALL_LINE_PCT = 3.0

/// How closely the fall line must point back toward the player for the green to
/// count as "back-to-front for THIS shot" (degrees). 45° is a generous
/// quarter-compass cone.
public let FALL_LINE_ALIGN_TOLERANCE_DEG = 45.0

/// Decision D9: the final window before the front edge that must be hazard-free
/// for the short-miss advice to be safe (meters).
public let FRONT_CLEAN_WINDOW_M = 30.0

/// Compass bearing (deg, 0 = north, cw) from `a` to `b` in planar meters.
private func caddyBearingDeg(_ a: Vec2, _ b: Vec2) -> Double {
    let deg = atan2(b.x - a.x, b.y - a.y) * 180 / .pi
    return (deg + 360).truncatingRemainder(dividingBy: 360)
}

/// Smallest absolute angle between two compass bearings, 0..180°.
private func angleBetween(_ aDeg: Double, _ bDeg: Double) -> Double {
    let d = abs((aDeg - bDeg).truncatingRemainder(dividingBy: 360) + 360)
        .truncatingRemainder(dividingBy: 360)
    return d > 180 ? 360 - d : d
}

/// Is the approach to the green front clean (decision D9)? Cast the shot line
/// origin → green-front and look for any hazard ring whose near edge lies within
/// the final FRONT_CLEAN_WINDOW_M before the front, capped at the front distance.
private func frontApproachClean<Club: ClubSpec>(_ ctx: CaddyContext<Club>) -> Bool {
    let origin = Vec2(x: ctx.origin.x, y: ctx.origin.y)
    let front = ctx.target.front
    let frontDistM = hypot(front.x - origin.x, front.y - origin.y)
    if frontDistM <= 0 { return true } // degenerate — already at the front
    let toFrontDeg = caddyBearingDeg(origin, front)
    let windowStart = frontDistM - FRONT_CLEAN_WINDOW_M

    let hits = hazardsAlongLine(origin, toFrontDeg, ctx.hazards, maxM: frontDistM)
    for hit in hits where hit.frontM >= windowStart {
        return false
    }
    return true
}

/// The green-slope-half rule as a value. Generic over the caller's `ClubSpec`
/// (the rule ignores clubs; the generic only lets it drop into a typed context).
/// Mirror of `green-slope-half.ts` `greenSlopeHalfRule`.
public func greenSlopeHalfRule<Club: ClubSpec>() -> CaddyRule<Club> {
    CaddyRule<Club>(
        id: "green-slope-half",
        // Cheap gate: only approaches, only when the slope summary is present.
        appliesTo: { ctx in
            ctx.leg == .approach && ctx.greenSlope != nil
        },
        evaluate: { ctx in
            guard let slope = ctx.greenSlope else { return [] }

            // 1. Steep enough to matter.
            if slope.fallLinePct < MIN_FALL_LINE_PCT { return [] }

            // 2. Fall line points back toward the player (back-to-front for THIS
            //    shot). The reverse shot bearing is green-front → origin.
            let reverseBearingDeg = caddyBearingDeg(
                ctx.target.front,
                Vec2(x: ctx.origin.x, y: ctx.origin.y)
            )
            if angleBetween(slope.fallLineBearingDeg, reverseBearingDeg) > FALL_LINE_ALIGN_TOLERANCE_DEG {
                return []
            }

            // 3. The front approach must be clean (D9).
            if !frontApproachClean(ctx) { return [] }

            // Confidence scales with how steep and how well-aligned the fall
            // line is; kept in [0.5, 1].
            let steepBonus = min(1, (slope.fallLinePct - MIN_FALL_LINE_PCT) / MIN_FALL_LINE_PCT)
            let alignBonus = 1 - angleBetween(slope.fallLineBearingDeg, reverseBearingDeg)
                / FALL_LINE_ALIGN_TOLERANCE_DEG
            let confidence = 0.5 + 0.5 * min(steepBonus, alignBonus)

            let detail = "The green falls about \(String(format: "%.0f", slope.fallLinePct))% "
                + "back-to-front, so a short miss feeds toward the pin while anything long leaves "
                + "a slippery downhiller — aim for the front half of the green."

            return [
                CaddyAdvice(
                    ruleId: "green-slope-half",
                    kind: .targetHalf,
                    priority: 3,
                    confidence: confidence,
                    headline: "Favour the short half — the green runs away from you.",
                    detail: detail,
                    anchor: ctx.target.front
                ),
            ]
        }
    )
}
