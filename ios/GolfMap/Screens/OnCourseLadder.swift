import Foundation

/// The unified "distance ladder" — every feature/target on the hole ahead of
/// the ball merged into one list sorted near→far, so it reads like walking the
/// hole. Backs the tall ("Full") state of the on-course distance card.
///
/// This is a pure presentation MERGE over uniform, already-measured inputs: the
/// model adapts its distance sources (plan legs, hazard carries, aim points,
/// green figures) + the layup engine into these positioned input structs, and
/// the builder sorts + tags them. It owns no geometry — every distance is a
/// whole-meter value and every `position` a WGS84 point the model resolved.
/// Kept pure + static so the merge, sort, and layup policy are unit-testable
/// without a live model. `position` lets a tapped row focus the map (step 4).
///
/// Web note: the web planner renders its yardage list straight from the shared
/// `featureDistances` engine, which has no plan-leg or layup-outcome rows. If
/// the ladder is ever brought to web, the plan/layup row policy below (and the
/// near→far merge) is the part that has to move with it — the hazard/aim/green
/// rows already exist there.
enum LadderBuilder {

    /// A planned landing point, distance measured from the current ball.
    struct PlanShot: Equatable {
        /// 1-based P-number (P1, P2…) in tee→green order.
        let index: Int
        let clubName: String?
        /// Straight distance from the ball to this landing point, whole meters.
        let meters: Int
        let position: LatLon
    }

    /// A carry hazard the shot line crosses (near/far edges), positioned at its
    /// near edge along the line.
    struct HazardItem: Equatable {
        let id: String
        let label: String
        let frontM: Int
        let carryM: Int
        let position: LatLon?
    }

    /// A placed aim / carry marker at its own point.
    struct AimItem: Equatable {
        let label: String
        let meters: Int
        let position: LatLon?
    }

    /// One layup outcome ("lay up → leaves X, club in"), positioned at where the
    /// club lands along the line.
    struct LayupItem: Equatable {
        let clubName: String
        let carryM: Int
        let remainingM: Int
        let approachClub: String?
        let position: LatLon?
    }

    /// The green figures for the terminal rows (center backs the sort key).
    struct Green: Equatable {
        let front: Int?
        let center: Int?
        let back: Int?
        let pin: Int?
        let pinName: String?
        let centerPosition: LatLon?
        let pinPosition: LatLon?
    }

    /// Merge every source into one near→far list. Positions come pre-resolved on
    /// each input; the caller measures plan-shot distances from the ball.
    static func build(
        planShots: [PlanShot],
        hazards: [HazardItem],
        aims: [AimItem],
        layups: [LayupItem],
        green: Green
    ) -> [OnCourseModel.LadderRow] {
        var rows: [OnCourseModel.LadderRow] = []

        for shot in planShots {
            rows.append(OnCourseModel.LadderRow(
                id: "plan-\(shot.index)", kind: .plan,
                label: "Plan P\(shot.index)", detail: shot.clubName,
                meters: shot.meters, carryM: nil, position: shot.position
            ))
        }

        for hazard in hazards {
            rows.append(OnCourseModel.LadderRow(
                id: "haz-\(hazard.id)", kind: .hazard,
                label: hazard.label, detail: "front / carry",
                meters: hazard.frontM, carryM: hazard.carryM, position: hazard.position
            ))
        }

        for (i, aim) in aims.enumerated() {
            rows.append(OnCourseModel.LadderRow(
                id: "aim-\(i)", kind: .aim,
                label: aim.label, detail: nil,
                meters: aim.meters, carryM: nil, position: aim.position
            ))
        }

        for layup in layups {
            let detail = "\(layup.remainingM) m in" + (layup.approachClub.map { " · \($0)" } ?? "")
            rows.append(OnCourseModel.LadderRow(
                id: "lay-\(layup.clubName)", kind: .layup,
                label: "Lay up", detail: detail,
                meters: layup.carryM, carryM: nil, position: layup.position
            ))
        }

        if let center = green.center {
            // "289 – 311" front→back range under the center figure, when known.
            let detail: String?
            if green.front != nil || green.back != nil {
                let f = green.front.map(String.init) ?? "–"
                let b = green.back.map(String.init) ?? "–"
                detail = "\(f) – \(b)"
            } else {
                detail = nil
            }
            rows.append(OnCourseModel.LadderRow(
                id: "green", kind: .green,
                label: "Green", detail: detail,
                meters: center, carryM: nil, position: green.centerPosition
            ))
        }

        if let pin = green.pin {
            rows.append(OnCourseModel.LadderRow(
                id: "pin", kind: .pin,
                label: "Pin" + (green.pinName.map { " · \($0)" } ?? ""), detail: nil,
                meters: pin, carryM: nil, position: green.pinPosition
            ))
        }

        // Near→far. Ties keep source order (Swift sort isn't stable, but the id
        // makes rows distinct and the display doesn't depend on tie order).
        return rows.sorted { $0.meters < $1.meters }
    }

    /// Ladder layup policy: layups are only meaningful when the green is out of
    /// range (the longest club falls short of center) — otherwise you'd just
    /// hit in. When it is, return one option per DISTINCT approach club (the
    /// longest carry that leaves that club, i.e. "lay up to leave your number"),
    /// nearest-first and capped so the list stays compact. Empty when the green
    /// is reachable or the bag is empty. The caller positions each option along
    /// the shot line by its carry.
    static func ladderLayups(clubs: [ClubRecord], rawCenterM: Double, cap: Int = 3) -> [LayupOption<ClubRecord>] {
        let longestCarry = clubs.map(\.carryM).max() ?? 0
        guard longestCarry < rawCenterM else { return [] }

        var byApproach: [String: LayupOption<ClubRecord>] = [:]
        for opt in layupOptions(clubs, rawCenterM) where !opt.reaches && opt.remainingM > 0 {
            let key = opt.approachClub?.name ?? "—"
            if let existing = byApproach[key], existing.carryM >= opt.carryM { continue }
            byApproach[key] = opt
        }
        return Array(byApproach.values.sorted { $0.carryM > $1.carryM }.prefix(cap))
    }
}
