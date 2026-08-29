import Foundation

/// Pure hole-selection logic: which hole is the player on, given the GPS fix
/// and the synced course holes. Auto-follows the round with hysteresis so the
/// selection never flaps mid-fairway, and supports a manual override that
/// auto-releases once the player clearly stands on another hole's tee.
struct HoleSelector: Equatable {

    /// Switch to a closer hole only when it beats the current one by this
    /// margin (meters) — parallel fairways stay stable.
    static let hysteresisM = 25.0
    /// Standing within this of a tee always locks that hole (and releases a
    /// manual override) — walking onto the next tee is the strongest signal.
    static let teeSnapM = 35.0
    /// A tee already in range only leaves it beyond teeSnapM + this buffer,
    /// so GPS jitter at the boundary can't re-arm the edge trigger.
    static let teeSnapExitBufferM = 15.0

    private(set) var currentIndex: Int
    /// True after `select(index:)`; auto-selection pauses until tee snap.
    private(set) var isManual = false
    /// Hole indices whose tee radius contained the previous fix. Tee snap is
    /// edge-triggered off this: it fires only on *entering* a radius, so a
    /// manual selection made while already standing near another hole's tee
    /// (chipping back from beside the next tee) is not instantly reverted.
    private var teesInRange: Set<Int> = []

    init(currentIndex: Int = 0) {
        self.currentIndex = currentIndex
    }

    /// Manual override from the UI (hole swipe / picker).
    mutating func select(index: Int, holeCount: Int) {
        guard (0..<holeCount).contains(index) else { return }
        currentIndex = index
        isManual = true
    }

    /// Hands the selection back to GPS (tap on the MANUAL pill). The next
    /// fix re-runs auto-selection from the current hole.
    mutating func releaseManual() {
        isManual = false
    }

    /// Feeds a GPS fix; returns true when the selection changed.
    @discardableResult
    mutating func update(fix: LatLon, holes: [WatchHole]) -> Bool {
        guard !holes.isEmpty else { return false }
        let previous = currentIndex
        let fixPoint = Sweref99TM.fromWGS84(fix)

        // Tee snap: walking onto a tee wins outright, manual or not — but
        // only on entering its radius, never while lingering inside it.
        var inRange: Set<Int> = []
        for (index, hole) in holes.enumerated() {
            guard let tee = hole.teeLatLon else { continue }
            let limit = teesInRange.contains(index)
                ? Self.teeSnapM + Self.teeSnapExitBufferM : Self.teeSnapM
            if planarDistance(fixPoint, to: tee) <= limit {
                inRange.insert(index)
            }
        }
        let entered = inRange.subtracting(teesInRange)
        teesInRange = inRange
        for index in holes.indices where index != currentIndex && entered.contains(index) {
            currentIndex = index
            isManual = false
            return true
        }

        guard !isManual else { return false }

        // Nearest hole by distance to the tee→green-center segment (the hole
        // corridor), with hysteresis against the current hole's score.
        var bestIndex = currentIndex
        var bestScore = score(fixPoint, holes: holes, index: currentIndex) ?? .infinity
        for index in holes.indices where index != currentIndex {
            guard let candidate = score(fixPoint, holes: holes, index: index) else { continue }
            if candidate + Self.hysteresisM < bestScore {
                bestScore = candidate
                bestIndex = index
            }
        }
        currentIndex = bestIndex
        return currentIndex != previous
    }

    /// Distance from the fix to the hole's tee→green segment, nil when the
    /// hole is missing either anchor.
    private func score(_ fix: Sweref99TM.Point, holes: [WatchHole], index: Int) -> Double? {
        guard holes.indices.contains(index) else { return nil }
        let hole = holes[index]
        guard let tee = hole.teeLatLon, let green = hole.greenCenterLatLon else { return nil }
        return Self.distanceToSegment(
            fix,
            a: Sweref99TM.fromWGS84(tee),
            b: Sweref99TM.fromWGS84(green)
        )
    }

    private func planarDistance(_ point: Sweref99TM.Point, to latLon: LatLon) -> Double {
        let other = Sweref99TM.fromWGS84(latLon)
        return ((point.x - other.x) * (point.x - other.x)
            + (point.y - other.y) * (point.y - other.y)).squareRoot()
    }

    /// Planar point→segment distance in meters.
    static func distanceToSegment(
        _ p: Sweref99TM.Point,
        a: Sweref99TM.Point,
        b: Sweref99TM.Point
    ) -> Double {
        let abx = b.x - a.x
        let aby = b.y - a.y
        let lengthSquared = abx * abx + aby * aby
        var t = 0.0
        if lengthSquared > 0 {
            t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared
            t = min(1, max(0, t))
        }
        let cx = a.x + t * abx
        let cy = a.y + t * aby
        return ((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy)).squareRoot()
    }
}

extension WatchHole {
    /// `[lat, lon]` wire pairs as typed points; nil when malformed.
    var teeLatLon: LatLon? { Self.latLon(tee) }
    var greenCenterLatLon: LatLon? { Self.latLon(greenCenter) }
    var greenFrontLatLon: LatLon? { greenFront.flatMap(Self.latLon) }
    var greenBackLatLon: LatLon? { greenBack.flatMap(Self.latLon) }

    private static func latLon(_ pair: [Double]) -> LatLon? {
        guard pair.count >= 2 else { return nil }
        return LatLon(lat: pair[0], lon: pair[1])
    }
}
