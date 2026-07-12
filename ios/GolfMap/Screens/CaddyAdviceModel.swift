import Foundation
import Observation

/// On-course smart-caddy advice, surfaced in the Green view (doc
/// feature-smart-caddy). Composes the platform inputs the pure caddy needs — the
/// green's slope summary (from the analysis grid the Green view already
/// sampled), the hole's hazard rings, the shot origin and the green reference
/// points — into a `CaddyContext`, runs `runCaddy`, and publishes the top piece
/// of advice.
///
/// **Green-view only (by design).** The advice needs a `GreenSlopeSummary`,
/// which is derived from the terrain-sampled `SampleGrid`. That grid is only
/// computed when the Green view is entered (async terrain-tile sampling over the
/// green + surrounds — NOT cheap), so there is no summary to hand the standard
/// hole-view distance card without entering Green view. The hint therefore lives
/// in the Green view panel, per the task's "keep it green-view-only if the grid
/// isn't cheap on the card" branch.
///
/// **Competition gating.** Caddy output is ADVICE, so it is withheld in
/// competition mode (same policy as the putt read / plays-like), exactly like
/// the web planner. `recompute` clears the advice when competition is on.
///
/// **Cadence.** Recomputed only on Green-view activation, grid settle, and
/// competition-toggle — never per frame. Cleared on hole change / deactivate.
@MainActor
@Observable
final class CaddyAdviceModel {

    /// The top-ranked advice for the current green, or nil (no advice, no grid
    /// yet, or competition mode).
    private(set) var advice: CaddyAdvice?

    /// Drop the advice (hole change / Green view exit).
    func clear() {
        advice = nil
    }

    /// Recompute from the current platform inputs. Pure over its arguments; the
    /// screen supplies them when the Green view activates or the grid settles.
    ///
    /// - Parameters:
    ///   - grid: the Green view's sampled terrain grid (nil until it settles).
    ///   - origin: shot origin (GPS fix / active tee), WGS84.
    ///   - targets: the hole's green markers (front/center/back).
    ///   - hazards: the course hazard rings (EPSG:3006), from `HazardFeatureStore`.
    ///   - par / strokeIndex: the hole descriptor.
    ///   - competition: when true, advice is withheld.
    func recompute(
        grid: SampleGrid?,
        origin: LatLon?,
        targets: HoleTargets,
        hazards: [FlatRing],
        par: Int,
        strokeIndex: Int?,
        competition: Bool
    ) {
        guard
            !competition,
            let grid,
            let origin,
            let frontLL = targets.greenFront,
            let centerLL = targets.greenCenter
        else {
            advice = nil
            return
        }

        let backLL = targets.greenBack ?? centerLL
        let o = Sweref99TM.fromWGS84(origin)
        let f = Sweref99TM.fromWGS84(frontLL)
        let c = Sweref99TM.fromWGS84(centerLL)
        let b = Sweref99TM.fromWGS84(backLL)

        guard let summary = GreenSlopeAdapter.summarize(
            grid: grid,
            front: GreenSlopeAdapter.RefPoint(e: f.x, n: f.y),
            back: GreenSlopeAdapter.RefPoint(e: b.x, n: b.y)
        ) else {
            advice = nil
            return
        }

        let pin = targets.activePin.map { p -> Vec2 in
            let sp = Sweref99TM.fromWGS84(p)
            return Vec2(x: sp.x, y: sp.y)
        }

        let ctx = CaddyContext<ClubRecord>(
            leg: .approach,
            origin: StrategyPoint(x: o.x, y: o.y),
            target: CaddyGreenTarget(
                // The green outline is unused by the green-slope rule; an empty
                // ring keeps the context faithful without threading the polygon.
                greenPoly: FlatRing(points: [], kind: "green"),
                center: Vec2(x: c.x, y: c.y),
                front: Vec2(x: f.x, y: f.y),
                back: Vec2(x: b.x, y: b.y),
                pin: pin
            ),
            greenSlope: summary,
            hazards: hazards,
            hole: CaddyHole(par: par, index: strokeIndex ?? 0),
            risk: RiskProfile(riskAversion: 0)
        )

        advice = runCaddy(ctx, [greenSlopeHalfRule()]).first
    }
}
