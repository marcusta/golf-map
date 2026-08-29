import Foundation

/// Precomputes a hole's distance-ladder targets for the watch bundle: hazard
/// line-crossings along the routed play line (tee → aims → green) plus the
/// authored aim points. Targets are fixed geographic points — the watch
/// measures fix→point live and owns no ring geometry ("the watch computes
/// nothing" rule). Pure + static so the crossing math is unit-testable.
enum WatchTargetBuilder {

    /// Most hazard crossings a hole ships; keeps the payload and the watch
    /// list compact (a routed line rarely crosses more).
    static let hazardCap = 6

    /// Ladder targets in tee→green order: hazard crossings along the routed
    /// `path`, then aim points. `surfaces` is the full course ring set —
    /// crossing the hole's own line is what scopes it to the hole.
    static func targets(
        path: [Sweref99TM.Point],
        aims: [AimPointRecord],
        surfaces: [FlatRing]
    ) -> [WatchTarget] {
        var out = hazardTargets(path: path, surfaces: surfaces)
        for (index, aim) in aims.enumerated() {
            out.append(WatchTarget(
                label: aim.label ?? "A\(index + 1)",
                kind: "aim",
                point: [aim.lat, aim.lon]
            ))
        }
        return out
    }

    private static func hazardTargets(
        path: [Sweref99TM.Point],
        surfaces: [FlatRing]
    ) -> [WatchTarget] {
        let hazards = surfaces.filter { HazardCarries.displayedTypes.contains($0.kind) }
        guard !hazards.isEmpty, path.count >= 2 else { return [] }

        var out: [WatchTarget] = []
        // Dedupe key: a ring straddling a path joint is hit from both legs.
        var seen = Set<String>()

        for legIndex in 0..<(path.count - 1) {
            let a = path[legIndex]
            let b = path[legIndex + 1]
            let dx = b.x - a.x
            let dy = b.y - a.y
            let lengthM = (dx * dx + dy * dy).squareRoot()
            guard lengthM > 0 else { continue }
            let deg = atan2(dx, dy) * 180 / .pi
            let bearingDeg = deg < 0 ? deg + 360 : deg
            let origin = Vec2(x: a.x, y: a.y)

            let crossings = hazardsAlongLine(origin, bearingDeg, hazards, maxM: lengthM)
                .sorted { $0.frontM < $1.frontM }
            for crossing in crossings {
                let near = point(origin, dx: dx / lengthM, dy: dy / lengthM, at: crossing.frontM)
                let far = point(origin, dx: dx / lengthM, dy: dy / lengthM, at: crossing.carryM)
                let key = "\(crossing.ring.kind)-\(Int(near.lat * 1e5))-\(Int(near.lon * 1e5))"
                guard seen.insert(key).inserted else { continue }
                out.append(WatchTarget(
                    label: HazardCarries.label(for: crossing.ring.kind),
                    kind: "hazard",
                    point: [near.lat, near.lon],
                    farPoint: [far.lat, far.lon]
                ))
                if out.count >= hazardCap { return out }
            }
        }
        return out
    }

    private static func point(_ origin: Vec2, dx: Double, dy: Double, at meters: Double) -> LatLon {
        Sweref99TM.toWGS84(Sweref99TM.Point(
            x: origin.x + dx * meters,
            y: origin.y + dy * meters
        ))
    }
}
