import Foundation

/// The game plan for one course as the on-course screen consumes it: per
/// hole, the authored shot tree (with resolved club NAMES), its primary-line
/// projection, and the target gates. Assembled from the GRDB cache by
/// `CoursePlan.make` —
/// pure values, no I/O, so the whole plan pipeline is unit-testable.
///
/// Read-only: plans are built on the web planner; the phone just shows them.
struct CoursePlan: Equatable, Sendable {

    /// One planned landing point. `sortOrder` ranks siblings; parent nil is a
    /// tee-root option.
    struct Shot: Equatable, Sendable, Identifiable {
        let id: String
        let position: LatLon
        let elevation: Double?
        let clubId: String?
        /// Resolved from the cached club bag; nil when the shot has no club
        /// or the club id is unknown (bag changed since planning).
        let clubName: String?
        let label: String?
        let sortOrder: Int
        let parentShotId: String?

        init(
            id: String,
            position: LatLon,
            elevation: Double?,
            clubId: String?,
            clubName: String?,
            label: String?,
            sortOrder: Int,
            parentShotId: String? = nil
        ) {
            self.id = id
            self.position = position
            self.elevation = elevation
            self.clubId = clubId
            self.clubName = clubName
            self.label = label
            self.sortOrder = sortOrder
            self.parentShotId = parentShotId
        }
    }

    /// One target gate: a cross-line at `position` perpendicular to
    /// `directionDeg` (direction of play), extending `halfWidthLeftM` /
    /// `halfWidthRightM` to either side of the line of play.
    struct Gate: Equatable, Sendable, Identifiable {
        let id: String
        let position: LatLon
        let directionDeg: Double
        let halfWidthLeftM: Double
        let halfWidthRightM: Double

        /// The gate's rendered endpoints (left, right — seen along the
        /// direction of play), computed in planar SWEREF 99 TM so the widths
        /// are true meters. Pure math, unit-tested.
        var endpoints: (left: LatLon, right: LatLon) {
            Self.endpoints(
                center: position,
                directionDeg: directionDeg,
                halfWidthLeftM: halfWidthLeftM,
                halfWidthRightM: halfWidthRightM
            )
        }

        static func endpoints(
            center: LatLon,
            directionDeg: Double,
            halfWidthLeftM: Double,
            halfWidthRightM: Double
        ) -> (left: LatLon, right: LatLon) {
            let p = Sweref99TM.fromWGS84(center)
            let theta = directionDeg * .pi / 180
            // Forward along the line of play is (E: sin θ, N: cos θ);
            // rotating 90° counterclockwise gives the left-hand direction.
            let leftE = -cos(theta)
            let leftN = sin(theta)
            let left = Sweref99TM.toWGS84(
                x: p.x + halfWidthLeftM * leftE,
                y: p.y + halfWidthLeftM * leftN
            )
            let right = Sweref99TM.toWGS84(
                x: p.x - halfWidthRightM * leftE,
                y: p.y - halfWidthRightM * leftN
            )
            return (left, right)
        }
    }

    /// One hole's plan (only holes with content are worth showing).
    struct HolePlan: Equatable, Sendable {
        let holeNumber: Int
        let teeId: String?
        let notes: String?
        /// Per-hole wind override; nil falls back to the plan-level wind.
        let windSpeedMps: Double?
        let windDirectionDeg: Double?
        /// Every authored node in the option tree.
        let allShots: [Shot]
        /// Compatibility projection used by existing plan consumers: follow
        /// rank-0 roots/children from tee to the primary-line tail.
        let shots: [Shot]
        let gates: [Gate]

        init(
            holeNumber: Int,
            teeId: String?,
            notes: String?,
            windSpeedMps: Double?,
            windDirectionDeg: Double?,
            shots: [Shot],
            gates: [Gate]
        ) {
            self.holeNumber = holeNumber
            self.teeId = teeId
            self.notes = notes
            self.windSpeedMps = windSpeedMps
            self.windDirectionDeg = windDirectionDeg
            allShots = shots
            self.shots = Self.primaryLine(in: shots)
            self.gates = gates
        }

        /// Ordered sibling choices at one decision point.
        func children(of parentShotId: String?) -> [Shot] {
            allShots
                .filter { $0.parentShotId == parentShotId }
                .sorted(by: Self.siblingOrder)
        }

        /// Full line containing `shotId`: ancestors from the tee, the chosen
        /// sibling, then rank-0 descendants. Invalid/cyclic trees return nil
        /// rather than hanging the on-course card.
        func line(selecting shotId: String) -> [Shot]? {
            let byId = Dictionary(
                allShots.map { ($0.id, $0) },
                uniquingKeysWith: { first, _ in first }
            )
            guard var cursor = byId[shotId] else { return nil }
            var reversed: [Shot] = []
            var seen = Set<String>()
            while true {
                guard seen.insert(cursor.id).inserted else { return nil }
                reversed.append(cursor)
                guard let parent = cursor.parentShotId else { break }
                guard let resolved = byId[parent] else { return nil }
                cursor = resolved
            }

            var line = Array(reversed.reversed())
            cursor = byId[shotId]!
            while let child = children(of: cursor.id).first {
                guard seen.insert(child.id).inserted else { return nil }
                line.append(child)
                cursor = child
            }
            return line
        }

        private static func primaryLine(in shots: [Shot]) -> [Shot] {
            let grouped = Dictionary(grouping: shots, by: \.parentShotId)
            var line: [Shot] = []
            var seen = Set<String>()
            var parent: String? = nil
            while let shot = grouped[parent]?.sorted(by: siblingOrder).first {
                guard seen.insert(shot.id).inserted else { break }
                line.append(shot)
                parent = shot.id
            }
            return line
        }

        private static func siblingOrder(_ lhs: Shot, _ rhs: Shot) -> Bool {
            lhs.sortOrder != rhs.sortOrder ? lhs.sortOrder < rhs.sortOrder : lhs.id < rhs.id
        }

        /// A hole plan with neither shots nor gates renders nothing.
        var hasContent: Bool { !shots.isEmpty || !gates.isEmpty }
    }

    /// The SERVER plan id — what a captured round links via `gamePlanId`.
    let id: String
    let courseId: String
    /// Plan-level default wind.
    let windSpeedMps: Double?
    let windDirectionDeg: Double?
    private let holesByNumber: [Int: HolePlan]

    /// True when at least one hole carries renderable plan content — gates
    /// the plan toggle's presence in the control stack.
    var hasContent: Bool { holesByNumber.values.contains(where: \.hasContent) }

    /// The plan for a hole number, or nil when the hole has no plan content.
    func hole(number: Int) -> HolePlan? {
        guard let plan = holesByNumber[number], plan.hasContent else { return nil }
        return plan
    }

    /// The wind in effect on a hole: its own override, else the plan default.
    func wind(holeNumber: Int) -> (speedMps: Double, directionDeg: Double)? {
        let hole = holesByNumber[holeNumber]
        guard
            let speed = hole?.windSpeedMps ?? windSpeedMps,
            let direction = hole?.windDirectionDeg ?? windDirectionDeg
        else { return nil }
        return (speed, direction)
    }

    /// The plan-level (course-wide) wind, ignoring any hole override.
    var planWind: (speedMps: Double, directionDeg: Double)? {
        guard let speed = windSpeedMps, let direction = windDirectionDeg else { return nil }
        return (speed, direction)
    }

    /// A hole's OWN wind override, or nil when it inherits the plan wind. Both
    /// halves must be present to count as an override — a half-filled pair
    /// falls through to the plan wind in `wind(holeNumber:)`, so it is not one.
    func windOverride(holeNumber: Int) -> (speedMps: Double, directionDeg: Double)? {
        guard
            let hole = holesByNumber[holeNumber],
            let speed = hole.windSpeedMps,
            let direction = hole.windDirectionDeg
        else { return nil }
        return (speed, direction)
    }

    /// An empty editable plan for a course with none cached yet — the planner
    /// tool synthesises this so the first shot has somewhere to land. The `id`
    /// is a placeholder (the DB layer owns the real, lazily-created plan id).
    static func empty(id: String = UUID().uuidString, courseId: String) -> CoursePlan {
        CoursePlan(
            id: id, courseId: courseId,
            windSpeedMps: nil, windDirectionDeg: nil, holesByNumber: [:]
        )
    }

    // MARK: - Editing (pure copy-on-write mutations for the planner tool)
    //
    // The planner tool rebuilds `OnCourseModel.plan` from these on every edit /
    // drag frame, so all derived geometry (route, nodes, ellipses, strategy
    // memo) recomputes reactively. Persistence to GRDB is a separate concern.

    /// The row id of a hole's plan (for the DB write path), or nil.
    func holeNumbers() -> [Int] { Array(holesByNumber.keys) }

    /// The current shots on a hole (empty if the hole has no plan yet).
    func shots(holeNumber: Int) -> [Shot] {
        holesByNumber[holeNumber]?.shots ?? []
    }

    private func replacingShots(holeNumber: Int, with shots: [Shot]) -> CoursePlan {
        var byNumber = holesByNumber
        if let existing = byNumber[holeNumber] {
            byNumber[holeNumber] = HolePlan(
                holeNumber: existing.holeNumber, teeId: existing.teeId, notes: existing.notes,
                windSpeedMps: existing.windSpeedMps, windDirectionDeg: existing.windDirectionDeg,
                shots: shots, gates: existing.gates
            )
        } else {
            byNumber[holeNumber] = HolePlan(
                holeNumber: holeNumber, teeId: nil, notes: nil,
                windSpeedMps: nil, windDirectionDeg: nil, shots: shots, gates: []
            )
        }
        return CoursePlan(
            id: id, courseId: courseId,
            windSpeedMps: windSpeedMps, windDirectionDeg: windDirectionDeg,
            holesByNumber: byNumber
        )
    }

    /// Copy with a shot's position (and elevation) moved. No-op if absent.
    func movingShot(holeNumber: Int, shotId: String, to position: LatLon, elevation: Double?) -> CoursePlan {
        let shots = (holesByNumber[holeNumber]?.allShots ?? []).map { shot -> Shot in
            guard shot.id == shotId else { return shot }
            return Shot(
                id: shot.id, position: position, elevation: elevation,
                clubId: shot.clubId, clubName: shot.clubName, label: shot.label,
                sortOrder: shot.sortOrder, parentShotId: shot.parentShotId
            )
        }
        return replacingShots(holeNumber: holeNumber, with: shots)
    }

    /// Copy with `shot` appended to a hole (creating the hole plan if needed).
    func addingShot(holeNumber: Int, _ shot: Shot) -> CoursePlan {
        replacingShots(
            holeNumber: holeNumber,
            with: (holesByNumber[holeNumber]?.allShots ?? []) + [shot]
        )
    }

    /// Copy with a shot removed from a hole. No-op if absent.
    func removingShot(holeNumber: Int, shotId: String) -> CoursePlan {
        replacingShots(
            holeNumber: holeNumber,
            with: (holesByNumber[holeNumber]?.allShots ?? []).filter { $0.id != shotId }
        )
    }

    // MARK: Wind (on-course wind editor)

    /// Copy with the plan-level (course-wide) wind replaced. A nil pair = calm.
    func settingPlanWind(speedMps: Double?, directionDeg: Double?) -> CoursePlan {
        CoursePlan(
            id: id, courseId: courseId,
            windSpeedMps: speedMps, windDirectionDeg: directionDeg,
            holesByNumber: holesByNumber
        )
    }

    /// Copy with one hole's wind override replaced (creating an otherwise-empty
    /// hole plan if the hole has none). A nil pair clears the override, so the
    /// hole inherits the plan wind again.
    func settingHoleWind(holeNumber: Int, speedMps: Double?, directionDeg: Double?) -> CoursePlan {
        var byNumber = holesByNumber
        if let existing = byNumber[holeNumber] {
            byNumber[holeNumber] = HolePlan(
                holeNumber: existing.holeNumber, teeId: existing.teeId, notes: existing.notes,
                windSpeedMps: speedMps, windDirectionDeg: directionDeg,
                shots: existing.shots, gates: existing.gates
            )
        } else {
            byNumber[holeNumber] = HolePlan(
                holeNumber: holeNumber, teeId: nil, notes: nil,
                windSpeedMps: speedMps, windDirectionDeg: directionDeg,
                shots: [], gates: []
            )
        }
        return CoursePlan(
            id: id, courseId: courseId,
            windSpeedMps: windSpeedMps, windDirectionDeg: windDirectionDeg,
            holesByNumber: byNumber
        )
    }

    /// Copy with a shot's club (id + resolved name) replaced. No-op if absent.
    func settingClub(holeNumber: Int, shotId: String, clubId: String?, clubName: String?) -> CoursePlan {
        let shots = (holesByNumber[holeNumber]?.allShots ?? []).map { shot -> Shot in
            guard shot.id == shotId else { return shot }
            return Shot(
                id: shot.id, position: shot.position, elevation: shot.elevation,
                clubId: clubId, clubName: clubName, label: shot.label,
                sortOrder: shot.sortOrder, parentShotId: shot.parentShotId
            )
        }
        return replacingShots(holeNumber: holeNumber, with: shots)
    }

    // MARK: - Assembly (pure adapter, GRDB records → display value)

    /// Joins the flat stored-plan records into per-hole plans and resolves
    /// club ids → names against the cached bag. Shots and gates are sorted by
    /// `sortOrder` regardless of storage order.
    static func make(stored: StoredGamePlan, clubs: [ClubRecord]) -> CoursePlan {
        let clubNames = Dictionary(clubs.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        let shotsByHole = Dictionary(grouping: stored.shots, by: \.gamePlanHoleId)
        let gatesByHole = Dictionary(grouping: stored.gates, by: \.gamePlanHoleId)

        var holesByNumber: [Int: HolePlan] = [:]
        for hole in stored.holes {
            let shots = (shotsByHole[hole.id] ?? [])
                .sorted { $0.sortOrder < $1.sortOrder }
                .map { shot in
                    Shot(
                        id: shot.id,
                        position: LatLon(lat: shot.lat, lon: shot.lon),
                        elevation: shot.elevation,
                        clubId: shot.clubId,
                        clubName: shot.clubId.flatMap { clubNames[$0] },
                        label: shot.label.flatMap { $0.isEmpty ? nil : $0 },
                        sortOrder: shot.sortOrder,
                        parentShotId: shot.parentShotId
                    )
                }
            let gates = (gatesByHole[hole.id] ?? [])
                .sorted { $0.sortOrder < $1.sortOrder }
                .map { gate in
                    Gate(
                        id: gate.id,
                        position: LatLon(lat: gate.lat, lon: gate.lon),
                        directionDeg: gate.directionDeg,
                        halfWidthLeftM: gate.halfWidthLeftM,
                        halfWidthRightM: gate.halfWidthRightM
                    )
                }
            holesByNumber[hole.holeNumber] = HolePlan(
                holeNumber: hole.holeNumber,
                teeId: hole.teeId,
                notes: hole.notes.flatMap { $0.isEmpty ? nil : $0 },
                windSpeedMps: hole.windSpeedMps,
                windDirectionDeg: hole.windDirectionDeg,
                shots: shots,
                gates: gates
            )
        }

        return CoursePlan(
            id: stored.plan.id,
            courseId: stored.plan.courseId,
            windSpeedMps: stored.plan.windSpeedMps,
            windDirectionDeg: stored.plan.windDirectionDeg,
            holesByNumber: holesByNumber
        )
    }
}
