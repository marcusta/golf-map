import Foundation

/// Shot-visualisation overlay geometry for the on-course plan viewer — the iOS
/// port of the web planner's `plan-overlay.ts` render slice (`buildHolePlan` +
/// `enrichPlanStrategy` + `ghostAimForLeg` + `legLight`). Pure value math: it
/// takes the hole's plan nodes, the club bag and the classified surface stack
/// and emits WGS84 geometry ready to drop onto `MLNShapeSource`s, with NO
/// MapLibre / Observation dependency, so it is fully unit-testable.
///
/// Strategy math (dispersion ellipses, aim optimisation, lie classification)
/// comes from the T1 port (`Ellipse.swift`, `Aim.swift`, `Lie.swift`, plus
/// `Wind.swift`/`Club.swift`); this module only assembles legs and converts
/// planar EPSG:3006 meters → WGS84 at the render boundary (`Sweref99TM`).
///
/// COMPUTE CADENCE (mirrors web decision DECADE §4.5): `optimizeAim` sweeps
/// ~13 candidates × 128 samples × point-in-ring per clubbed leg — far too heavy
/// for a per-frame path. `OnCourseModel` memoises the whole result and only
/// recomputes it when the plan / hole / wind / bag / surfaces change, never
/// during pan/gesture.
public enum PlanStrategy {

    // MARK: - Overlay geometry (WGS84, render-ready)

    /// One dispersion ellipse polygon (closed WGS84 ring) for a clubbed leg,
    /// with the metadata the on-course overlay needs to label it and drive
    /// selection-scoped visibility (labels anchor at `center`; a selected plan
    /// waypoint shows only its incoming/outgoing legs via the shot ids —
    /// ellipses are built per-leg with `continue` guards, so positional
    /// zipping against the leg list is NOT safe).
    public struct EllipseShape: Equatable, Sendable {
        public var polygon: [LatLon]
        /// Pattern center (drift-shifted expected landing) — the label anchor.
        public var center: LatLon
        /// Resolved leg club display name (nil: label falls back to meters only).
        public var clubName: String?
        /// The leg's ground length, whole meters (the label figure).
        public var legMeters: Int
        /// Shot id of the plan node this leg DEPARTS (nil: departs the tee).
        public var fromShotId: String?
        /// Shot id of the plan node this leg LANDS on (nil: lands on the green).
        public var toShotId: String?

        public init(
            polygon: [LatLon],
            center: LatLon,
            clubName: String? = nil,
            legMeters: Int = 0,
            fromShotId: String? = nil,
            toShotId: String? = nil
        ) {
            self.polygon = polygon
            self.center = center
            self.clubName = clubName
            self.legMeters = legMeters
            self.fromShotId = fromShotId
            self.toShotId = toShotId
        }
    }

    /// The recommended-aim "ghost" group for one enriched leg: the hollow aim
    /// marker (`aim`, "point here"), the dashed pattern that aim would produce
    /// (`ellipse`), a dot at its drift-shifted finish (`center`), and the
    /// aim→finish connector (`driftLine`, only once the drift is visible).
    public struct GhostShape: Equatable, Sendable {
        public var aim: LatLon
        public var center: LatLon
        public var ellipse: [LatLon]
        /// [aim, center] when |drift| ≥ `driftLabelMinM`, else nil.
        public var driftLine: [LatLon]?
        public init(aim: LatLon, center: LatLon, ellipse: [LatLon], driftLine: [LatLon]?) {
            self.aim = aim
            self.center = center
            self.ellipse = ellipse
            self.driftLine = driftLine
        }
    }

    /// A confidence-tinted APPROACH leg segment ([from, to]) with its light.
    public struct LegTintShape: Equatable, Sendable {
        public var line: [LatLon]
        public var light: LegLight
        public init(line: [LatLon], light: LegLight) {
            self.line = line
            self.light = light
        }
    }

    /// Panel-facing per-leg strategy result — the scalar `optimizeAim` output
    /// `compute` already produces for the map ghost, surfaced so the smart caddy
    /// can reuse it WITHOUT a second aim sweep. One per clubbed leg (every leg
    /// that draws an ellipse). `legIndex` is the 1-based leg index (the leg
    /// ENDING at plan node `legIndex`); `landsOnGreen` marks the approach leg.
    ///
    /// INVARIANT (verify before editing `compute`): `greenCenterPlanar` is the
    /// hole's terminal node for EVERY leg — the same target `optimizeAim` scored
    /// against — so a caddy context built from this reproduces the web
    /// `buildLegContext` numbers exactly. If a future plan ever terminates
    /// somewhere other than the green centre, revisit this.
    public struct LegPlan: Equatable, Sendable {
        public var legIndex: Int
        public var landsOnGreen: Bool
        public var resolvedClubId: String
        public var aim: AimResult
        /// Recommended-aim landing point (the ghost marker) — where "apply
        /// recommended aim" would move this leg's shot.
        public var landingWGS84: LatLon
        public var landingPlanar: Vec2
        public var fromPlanar: Vec2
        public var greenCenterPlanar: Vec2

        public init(
            legIndex: Int, landsOnGreen: Bool, resolvedClubId: String, aim: AimResult,
            landingWGS84: LatLon, landingPlanar: Vec2, fromPlanar: Vec2, greenCenterPlanar: Vec2
        ) {
            self.legIndex = legIndex
            self.landsOnGreen = landsOnGreen
            self.resolvedClubId = resolvedClubId
            self.aim = aim
            self.landingWGS84 = landingWGS84
            self.landingPlanar = landingPlanar
            self.fromPlanar = fromPlanar
            self.greenCenterPlanar = greenCenterPlanar
        }
    }

    /// The full shot-viz overlay for one hole.
    public struct Geometry: Equatable, Sendable {
        public var ellipses: [EllipseShape]
        public var ghosts: [GhostShape]
        public var legTints: [LegTintShape]
        /// Per-leg aim results for the caddy (empty on the cheap drag path).
        public var legPlans: [LegPlan]

        public init(
            ellipses: [EllipseShape], ghosts: [GhostShape],
            legTints: [LegTintShape], legPlans: [LegPlan] = []
        ) {
            self.ellipses = ellipses
            self.ghosts = ghosts
            self.legTints = legTints
            self.legPlans = legPlans
        }

        public static let empty = Geometry(ellipses: [], ghosts: [], legTints: [], legPlans: [])
        public var isEmpty: Bool {
            ellipses.isEmpty && ghosts.isEmpty && legTints.isEmpty && legPlans.isEmpty
        }
    }

    // MARK: - Confidence light (mirror of plan-overlay.ts legLight)

    public enum LegLight: String, Equatable, Sendable {
        case green
        case yellow
        case red
    }

    /// Trouble share above this → at best yellow (a slice misses the short side).
    static let lightTroubleYellow = 0.1
    /// Trouble share ≥ this (or any penalty) → red (bail to the fat side).
    static let lightTroubleRed = 0.25
    /// Green-hit share below this → at best yellow (green rarely held).
    static let lightGreenHeld = 0.6
    /// Show the crosswind hold / drift connector once it matters on the ground.
    static let driftLabelMinM = 3.0

    /// Confidence light for an APPROACH leg from its aim `breakdown`. Nil when
    /// the leg is not an approach (does not land on the green). Pure — mirror of
    /// `plan-overlay.ts` `legLight`.
    static func legLight(breakdown: [Lie: Double], isApproach: Bool) -> LegLight? {
        guard isApproach else { return nil }
        let penalty = breakdown[.penalty] ?? 0
        let trouble = penalty + (breakdown[.sand] ?? 0) + (breakdown[.recovery] ?? 0)
        let green = breakdown[.green] ?? 0
        if penalty > 0 || trouble >= lightTroubleRed { return .red }
        if trouble >= lightTroubleYellow || green < lightGreenHeld { return .yellow }
        return .green
    }

    // MARK: - Plan node input

    enum NodeKind: Equatable, Sendable { case tee, shot, green }

    /// One node of the hole's planning sequence (tee → landing shots → green).
    struct Node: Equatable, Sendable {
        var latLon: LatLon
        var elevation: Double?
        var kind: NodeKind
        /// The landing shot's club id (nil for tee/green nodes) — the leg
        /// ENDING at this node adopts it.
        var clubId: String?
        /// The backing plan shot's id (nil for tee/green nodes) — stamped onto
        /// the adjacent legs' `EllipseShape`s so selection can address them.
        var shotId: String?

        init(
            latLon: LatLon, elevation: Double?, kind: NodeKind,
            clubId: String? = nil, shotId: String? = nil
        ) {
            self.latLon = latLon
            self.elevation = elevation
            self.kind = kind
            self.clubId = clubId
            self.shotId = shotId
        }
    }

    // MARK: - Builder

    /// Build the hole's shot-viz overlay. One dispersion ellipse + one aim
    /// sweep per leg with a RESOLVED club (the landing shot's club, or — since
    /// the iOS viewer has no per-hole preferred club — the bag's closest club
    /// to the leg's wind-adjusted plays-like distance, matching the card's
    /// suggested-club fallback). Legs with no resolvable club (empty bag) draw
    /// nothing. Confidence tints only on approach legs (landing on the green).
    ///
    /// `wind` is the effective hole wind (already competition-gated by the
    /// caller — this function is geometry only).
    static func compute(
        nodes: [Node],
        clubs: [ClubRecord],
        surfaces: [FlatRing],
        wind: (speedMps: Double, directionDeg: Double)?
    ) -> Geometry {
        guard nodes.count >= 2 else { return .empty }

        let clubById = Dictionary(clubs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let planar = nodes.map { node -> Vec2 in
            let p = Sweref99TM.fromWGS84(node.latLon)
            return Vec2(x: p.x, y: p.y)
        }
        // Terminal target for remaining-distance scoring (the green center).
        let greenCenter = planar[nodes.count - 1]

        var ellipses: [EllipseShape] = []
        var ghosts: [GhostShape] = []
        var legTints: [LegTintShape] = []
        var legPlans: [LegPlan] = []

        for i in 1..<nodes.count {
            let from = planar[i - 1]
            let to = planar[i]
            let toNode = nodes[i]

            let dx = to.x - from.x
            let dy = to.y - from.y
            let horizontal = (dx * dx + dy * dy).squareRoot()
            guard horizontal > 0 else { continue }
            let bearingDeg = Self.compassBearing(dx: dx, dy: dy)

            // Leg slope (signed elevationΔ / horizontal run) — projects the
            // club's air carry onto the ground, same as buildHolePlan.
            let elevationDelta: Double? = {
                guard let a = nodes[i - 1].elevation, let b = toNode.elevation else { return nil }
                return b - a
            }()
            let groundSlope = elevationDelta.map { $0 / horizontal } ?? 0

            // Resolve the leg's club: the landing shot's explicit club, else
            // the bag's closest to the leg's plays-like (elevation + wind)
            // distance — the same fallback the card's plan strip uses.
            let club = toNode.clubId.flatMap { clubById[$0] }
                ?? Self.suggestedClub(
                    clubs: clubs, from: from, to: to,
                    fromElevation: nodes[i - 1].elevation, toElevation: toNode.elevation,
                    horizontal: horizontal, bearingDeg: bearingDeg, wind: wind
                )
            guard let club else { continue }

            let ellipse = dispersionEllipse(DispersionEllipseOptions(
                origin: from,
                bearingDeg: bearingDeg,
                club: club,
                windSpeedMps: wind?.speedMps,
                windDirectionDeg: wind?.directionDeg,
                groundSlope: groundSlope
            ))
            ellipses.append(Self.ellipseShape(
                ellipse, club: club, horizontal: horizontal,
                fromNode: nodes[i - 1], toNode: toNode
            ))

            let aim = optimizeAim(AimOptions(
                origin: from,
                club: club,
                targetBearingDeg: bearingDeg,
                surfaces: surfaces,
                greenCenter: greenCenter,
                windSpeedMps: wind?.speedMps,
                windDirectionDeg: wind?.directionDeg,
                groundSlope: groundSlope
            ))

            // Confidence tint — approach legs only (landing on the green).
            if let light = legLight(breakdown: aim.breakdown, isApproach: toNode.kind == .green) {
                legTints.append(LegTintShape(
                    line: [nodes[i - 1].latLon, toNode.latLon], light: light
                ))
            }

            // Ghost recommended-aim group (mirror of ghostAimForLeg): project
            // the leg's own wind-adjusted carry forward along the RECOMMENDED
            // bearing, and draw the pattern that aim would produce.
            let effect = wind.map { windEffect($0.speedMps, $0.directionDeg, bearingDeg, club.carryM) } ?? 0
            let carryAir = adjustedCarryM(club.carryM, effect)
            let carry = 1 + groundSlope > 0 ? carryAir / (1 + groundSlope) : carryAir
            let unit = bearingToUnitVector(aim.bestBearingDeg)
            let aimPoint = Vec2(x: from.x + unit.x * carry, y: from.y + unit.y * carry)

            let recommended = dispersionEllipse(DispersionEllipseOptions(
                origin: from,
                bearingDeg: aim.bestBearingDeg,
                club: club,
                windSpeedMps: wind?.speedMps,
                windDirectionDeg: wind?.directionDeg,
                groundSlope: groundSlope
            ))
            let driftLine: [LatLon]? = abs(recommended.driftM) >= driftLabelMinM
                ? [Self.wgs84(aimPoint), Self.wgs84(recommended.center)]
                : nil
            ghosts.append(GhostShape(
                aim: Self.wgs84(aimPoint),
                center: Self.wgs84(recommended.center),
                ellipse: recommended.polygon.map(Self.wgs84),
                driftLine: driftLine
            ))

            // Surface the leg's aim result for the caddy — the SAME `aim` /
            // `aimPoint` the ghost above used, so no second optimizeAim sweep.
            legPlans.append(LegPlan(
                legIndex: i,
                landsOnGreen: toNode.kind == .green,
                resolvedClubId: club.id,
                aim: aim,
                landingWGS84: Self.wgs84(aimPoint),
                landingPlanar: aimPoint,
                fromPlanar: from,
                greenCenterPlanar: greenCenter
            ))
        }

        return Geometry(ellipses: ellipses, ghosts: ghosts, legTints: legTints, legPlans: legPlans)
    }

    /// The CHEAP drag-frame slice of `compute`: per-leg dispersion ellipses
    /// ONLY — no `optimizeAim` sweep, so no ghost aim and no confidence tints.
    /// Runs the same club-resolution + dispersion math as `compute` but skips
    /// the ~13-candidate aim optimisation, making it safe on the per-frame drag
    /// path (task T3 drag cadence; mirrors the web planner's live-ellipse
    /// behaviour where ghost/lights fall out mid-drag and re-enrich on release).
    static func ellipsesOnly(
        nodes: [Node],
        clubs: [ClubRecord],
        wind: (speedMps: Double, directionDeg: Double)?
    ) -> [EllipseShape] {
        guard nodes.count >= 2 else { return [] }
        let clubById = Dictionary(clubs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let planar = nodes.map { node -> Vec2 in
            let p = Sweref99TM.fromWGS84(node.latLon)
            return Vec2(x: p.x, y: p.y)
        }

        var ellipses: [EllipseShape] = []
        for i in 1..<nodes.count {
            let from = planar[i - 1]
            let to = planar[i]
            let toNode = nodes[i]
            let dx = to.x - from.x
            let dy = to.y - from.y
            let horizontal = (dx * dx + dy * dy).squareRoot()
            guard horizontal > 0 else { continue }
            let bearingDeg = Self.compassBearing(dx: dx, dy: dy)
            let elevationDelta: Double? = {
                guard let a = nodes[i - 1].elevation, let b = toNode.elevation else { return nil }
                return b - a
            }()
            let groundSlope = elevationDelta.map { $0 / horizontal } ?? 0

            let club = toNode.clubId.flatMap { clubById[$0] }
                ?? Self.suggestedClub(
                    clubs: clubs, from: from, to: to,
                    fromElevation: nodes[i - 1].elevation, toElevation: toNode.elevation,
                    horizontal: horizontal, bearingDeg: bearingDeg, wind: wind
                )
            guard let club else { continue }

            let ellipse = dispersionEllipse(DispersionEllipseOptions(
                origin: from,
                bearingDeg: bearingDeg,
                club: club,
                windSpeedMps: wind?.speedMps,
                windDirectionDeg: wind?.directionDeg,
                groundSlope: groundSlope
            ))
            ellipses.append(Self.ellipseShape(
                ellipse, club: club, horizontal: horizontal,
                fromNode: nodes[i - 1], toNode: toNode
            ))
        }
        return ellipses
    }

    // MARK: - Helpers

    /// Shared `EllipseShape` assembly for `compute` and `ellipsesOnly` (the
    /// drag path) — both MUST fill the same label/selection metadata.
    private static func ellipseShape(
        _ ellipse: DispersionEllipse, club: ClubRecord, horizontal: Double,
        fromNode: Node, toNode: Node
    ) -> EllipseShape {
        EllipseShape(
            polygon: ellipse.polygon.map(Self.wgs84),
            center: Self.wgs84(ellipse.center),
            clubName: club.name,
            legMeters: Int(horizontal.rounded()),
            fromShotId: fromNode.shotId,
            toShotId: toNode.shotId
        )
    }

    /// Planar initial bearing, compass degrees [0, 360): atan2(Δx, Δy).
    static func compassBearing(dx: Double, dy: Double) -> Double {
        let deg = atan2(dx, dy) * 180 / .pi
        return deg < 0 ? deg + 360 : deg
    }

    private static func wgs84(_ p: Vec2) -> LatLon {
        Sweref99TM.toWGS84(x: p.x, y: p.y)
    }

    /// Bag's closest club to the leg's playing distance (plays-like when both
    /// endpoints have elevation, then wind "plays as") — the same composition
    /// as `OnCourseModel.suggestedClub`, so an ellipse's club matches the
    /// card's suggested club.
    private static func suggestedClub(
        clubs: [ClubRecord],
        from: Vec2, to: Vec2,
        fromElevation: Double?, toElevation: Double?,
        horizontal: Double, bearingDeg: Double,
        wind: (speedMps: Double, directionDeg: Double)?
    ) -> ClubRecord? {
        guard !clubs.isEmpty else { return nil }
        var base = horizontal
        if let fe = fromElevation, let te = toElevation {
            let stats = PlaysLike.segmentStats(
                PlaysLike.Point(e: from.x, n: from.y, elevation: fe),
                PlaysLike.Point(e: to.x, n: to.y, elevation: te)
            )
            if let pl = stats.playsLikeSimple { base = pl }
        }
        if let wind {
            base = playsAsM(base, windEffect(wind.speedMps, wind.directionDeg, bearingDeg, base))
        }
        return closestClub(clubs, base)
    }
}
