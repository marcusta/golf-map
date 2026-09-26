import Foundation

/// Picks the hole a photo was taken on: the hole whose play line (tees →
/// aim points → green center) passes closest to the fix. Distances are planar
/// SWEREF 99 TM metres. A hole with no geometry is skipped.
enum NearestHole {
    struct Line: Sendable, Equatable {
        var number: Int
        var points: [LatLon]
    }

    static func line(for hole: OnCourseModel.HoleData) -> Line {
        var points = hole.tees.map { LatLon(lat: $0.lat, lon: $0.lon) }
        // Tees sit roughly on the line behind the first aim point, so chaining
        // them in sortOrder keeps the polyline close to the hole's corridor.
        points += hole.aimPoints.map { LatLon(lat: $0.lat, lon: $0.lon) }
        if let green = hole.green {
            points.append(LatLon(lat: green.centerLat, lon: green.centerLon))
        }
        return Line(number: hole.hole.number, points: points)
    }

    /// Nil when no hole has geometry.
    static func number(at fix: LatLon, lines: [Line]) -> Int? {
        var best: (number: Int, distance: Double)?
        for line in lines where !line.points.isEmpty {
            let d = distance(from: fix, to: line.points)
            if best == nil || d < best!.distance {
                best = (line.number, d)
            }
        }
        return best?.number
    }

    /// Minimum distance from `p` to the polyline through `points`.
    static func distance(from p: LatLon, to points: [LatLon]) -> Double {
        let q = Sweref99TM.fromWGS84(p)
        let xy = points.map { Sweref99TM.fromWGS84($0) }
        guard xy.count > 1 else {
            return xy.first.map { hypot($0.x - q.x, $0.y - q.y) } ?? .infinity
        }
        var best = Double.infinity
        for i in 0..<(xy.count - 1) {
            let a = xy[i], b = xy[i + 1]
            let dx = b.x - a.x, dy = b.y - a.y
            let len2 = dx * dx + dy * dy
            let t = len2 > 0 ? max(0, min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2)) : 0
            best = min(best, hypot(a.x + t * dx - q.x, a.y + t * dy - q.y))
        }
        return best
    }
}
