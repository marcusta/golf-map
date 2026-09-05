import Foundation

/// Pure geometry for the hole flyover: the smoothed ground path (tee → aim
/// points → green centre), the camera pose along it, and the timing. No map
/// or UIKit dependency, so the whole thing is unit-testable; `FlyoverAnimator`
/// turns poses into `MLNMapCamera`s per display frame.
///
/// All lengths are metres. Path maths runs in projected SWEREF 99 TM
/// (EPSG:3006), like `Distance.planarMeters`; headings are degrees clockwise
/// from north.
public struct FlyoverPath: Equatable, Sendable {
    /// A planar point on the densified path.
    public struct Vertex: Equatable, Sendable {
        public var x: Double
        public var y: Double
        /// Arc length from the path start.
        public var distance: Double
    }

    public let vertices: [Vertex]

    /// Total arc length.
    public var length: Double { vertices.last?.distance ?? 0 }

    /// Builds a Catmull-Rom spline through `waypoints` (the spline passes
    /// through every waypoint) and samples it about every `sampleSpacing`
    /// metres. Consecutive duplicate waypoints collapse; two distinct
    /// waypoints give a straight line. Nil with fewer than two distinct points.
    public static func build(waypoints: [LatLon], sampleSpacing: Double = 5) -> FlyoverPath? {
        var control: [(x: Double, y: Double)] = []
        for waypoint in waypoints {
            let p = Sweref99TM.fromWGS84(waypoint)
            if let last = control.last, hypot(p.x - last.x, p.y - last.y) < 0.5 { continue }
            control.append((p.x, p.y))
        }
        guard control.count >= 2 else { return nil }

        // Duplicate the end points so the spline is defined over every segment.
        let padded = [control[0]] + control + [control[control.count - 1]]
        var samples: [(x: Double, y: Double)] = [control[0]]
        let spacing = max(sampleSpacing, 0.5)
        for i in 1..<(padded.count - 2) {
            let p0 = padded[i - 1], p1 = padded[i], p2 = padded[i + 1], p3 = padded[i + 2]
            let chord = hypot(p2.x - p1.x, p2.y - p1.y)
            let steps = max(1, Int((chord / spacing).rounded(.up)))
            for step in 1...steps {
                let t = Double(step) / Double(steps)
                samples.append(catmullRom(p0, p1, p2, p3, t))
            }
        }

        var vertices: [Vertex] = []
        var distance = 0.0
        for (index, s) in samples.enumerated() {
            if index > 0 {
                let prev = samples[index - 1]
                distance += hypot(s.x - prev.x, s.y - prev.y)
            }
            vertices.append(Vertex(x: s.x, y: s.y, distance: distance))
        }
        return FlyoverPath(vertices: vertices)
    }

    private static func catmullRom(
        _ p0: (x: Double, y: Double), _ p1: (x: Double, y: Double),
        _ p2: (x: Double, y: Double), _ p3: (x: Double, y: Double),
        _ t: Double
    ) -> (x: Double, y: Double) {
        let t2 = t * t, t3 = t2 * t
        func axis(_ a: Double, _ b: Double, _ c: Double, _ d: Double) -> Double {
            0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
        }
        return (axis(p0.x, p1.x, p2.x, p3.x), axis(p0.y, p1.y, p2.y, p3.y))
    }

    /// Planar point at arc length `distance` (clamped to the path; the path
    /// extends as a straight line beyond either end for negative or
    /// past-the-end distances so a trailing camera eye has a position).
    public func point(at distance: Double) -> (x: Double, y: Double) {
        guard let first = vertices.first, let last = vertices.last else { return (0, 0) }
        if vertices.count == 1 { return (first.x, first.y) }
        if distance <= 0 {
            let h = heading(at: 0) * .pi / 180
            return (first.x + sin(h) * distance, first.y + cos(h) * distance)
        }
        if distance >= last.distance {
            let h = heading(at: last.distance) * .pi / 180
            let over = distance - last.distance
            return (last.x + sin(h) * over, last.y + cos(h) * over)
        }
        let index = segmentIndex(at: distance)
        let a = vertices[index], b = vertices[index + 1]
        let span = b.distance - a.distance
        let t = span > 0 ? (distance - a.distance) / span : 0
        return (a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    }

    /// WGS84 point at arc length `distance`.
    public func coordinate(at distance: Double) -> LatLon {
        let p = point(at: distance)
        return Sweref99TM.toWGS84(x: p.x, y: p.y)
    }

    /// Direction of travel at arc length `distance`, degrees clockwise from
    /// north. Constant along a segment; the end segments extend past the ends.
    public func heading(at distance: Double) -> Double {
        guard vertices.count >= 2 else { return 0 }
        let clamped = min(max(distance, 0), length)
        let index = clamped >= length ? vertices.count - 2 : segmentIndex(at: clamped)
        let a = vertices[index], b = vertices[index + 1]
        return Self.headingDegrees(dx: b.x - a.x, dy: b.y - a.y)
    }

    /// Index of the segment `[i, i+1]` containing `distance` (0 ≤ distance < length).
    private func segmentIndex(at distance: Double) -> Int {
        var lo = 0, hi = vertices.count - 2
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if vertices[mid].distance <= distance { lo = mid } else { hi = mid - 1 }
        }
        return lo
    }

    /// Planar direction to a compass heading in `[0, 360)`.
    static func headingDegrees(dx: Double, dy: Double) -> Double {
        let degrees = atan2(dx, dy) * 180 / .pi
        return degrees < 0 ? degrees + 360 : degrees
    }
}

/// One camera frame of the flyover, in MapLibre camera terms.
public struct FlyoverPose: Equatable, Sendable {
    /// Ground point the camera looks at.
    public var center: LatLon
    /// Camera eye height above the map plane at `center`, metres.
    public var altitude: Double
    /// Tilt from straight down, degrees (0 = top-down).
    public var pitch: Double
    /// Compass heading the camera faces, degrees clockwise from north.
    public var heading: Double
}

/// A complete flyover: path, ground profile and the camera/timing model.
public struct FlyoverPlan: Equatable, Sendable {
    /// Camera eye height above the local ground.
    public static let eyeHeight = 45.0
    /// The look-at point runs this far ahead of the current path point.
    public static let lookAhead = 120.0
    /// The eye trails this far behind the current path point.
    public static let trailBehind = 80.0
    /// MapLibre iOS caps camera pitch at 60°; a steeper geometric pitch pulls
    /// the look-at point back towards the eye instead.
    public static let maxPitch = 60.0
    /// Ground speed: 300 m in 8 s.
    public static let speed = 300.0 / 8.0
    /// Shortest flight, so a par-3 does not flash past.
    public static let minimumFlightDuration = 4.0
    /// Speed ramps at the start and end.
    public static let rampDuration = 1.5
    /// Hold above and behind the green after the flight.
    public static let holdDuration = 2.0
    /// Spacing of the ground-elevation profile samples.
    public static let profileSpacing = 10.0

    public let path: FlyoverPath
    /// Ground elevation sampled every `profileSpacing` metres from
    /// `-trailBehind` (the eye's starting position) to the path end.
    public let groundProfile: [Double]

    public init(path: FlyoverPath, groundProfile: [Double]) {
        self.path = path
        self.groundProfile = groundProfile
    }

    /// The WGS84 points a caller samples ground elevation at, in the order
    /// `init(path:groundElevations:)` expects them.
    public static func profileSamplePositions(for path: FlyoverPath) -> [LatLon] {
        profileDistances(for: path).map { path.coordinate(at: $0) }
    }

    static func profileDistances(for path: FlyoverPath) -> [Double] {
        var distances: [Double] = []
        var d = -trailBehind
        while d < path.length {
            distances.append(d)
            d += profileSpacing
        }
        distances.append(path.length)
        return distances
    }

    /// Builds a plan from raw elevation samples (one per
    /// `profileSamplePositions`); missing samples take the nearest known
    /// value, and an all-nil profile is flat.
    public init(path: FlyoverPath, groundElevations: [Double?]) {
        var filled: [Double] = []
        let known = groundElevations.enumerated().compactMap { index, value in
            value.map { (index: index, value: $0) }
        }
        for index in groundElevations.indices {
            if let value = groundElevations[index] {
                filled.append(value)
            } else if let nearest = known.min(by: { abs($0.index - index) < abs($1.index - index) }) {
                filled.append(nearest.value)
            } else {
                filled.append(0)
            }
        }
        self.init(path: path, groundProfile: filled)
    }

    /// Ground elevation at arc length `distance`, linearly interpolated from
    /// the profile (clamped at both ends). 0 without a profile.
    public func groundElevation(at distance: Double) -> Double {
        guard !groundProfile.isEmpty else { return 0 }
        let position = (distance + Self.trailBehind) / Self.profileSpacing
        let lower = Int(position.rounded(.down))
        if lower < 0 { return groundProfile[0] }
        if lower >= groundProfile.count - 1 { return groundProfile[groundProfile.count - 1] }
        let t = position - Double(lower)
        return groundProfile[lower] + (groundProfile[lower + 1] - groundProfile[lower]) * t
    }

    // MARK: Timing

    /// Flight time (excluding the end hold).
    public var flightDuration: Double {
        max(Self.minimumFlightDuration, path.length / Self.speed)
    }

    /// Flight plus hold.
    public var totalDuration: Double { flightDuration + Self.holdDuration }

    /// Distance along the path at time `t`: a trapezoidal speed profile with
    /// `rampDuration` ramps at each end. Clamped to `[0, length]`.
    public func distance(atTime t: Double) -> Double {
        let duration = flightDuration
        let length = path.length
        if t <= 0 { return 0 }
        if t >= duration { return length }
        let ramp = min(Self.rampDuration, duration / 2)
        let peakSpeed = length / (duration - ramp)
        if t < ramp {
            return peakSpeed * t * t / (2 * ramp)
        }
        if t <= duration - ramp {
            return peakSpeed * (t - ramp / 2)
        }
        let remaining = duration - t
        return length - peakSpeed * remaining * remaining / (2 * ramp)
    }

    // MARK: Pose

    /// Camera pose at time `t` (the end pose during the hold).
    public func pose(atTime t: Double) -> FlyoverPose {
        pose(atDistance: distance(atTime: min(t, flightDuration)))
    }

    /// Camera pose for the path point at arc length `distance`: the eye trails
    /// `trailBehind` metres behind it at `eyeHeight` above its own ground,
    /// looking at the point `lookAhead` metres further along the path (capped
    /// at the path end, so the last frames look at the green from behind).
    /// The eye altitude is relative to the look-at point's ground, so a tee
    /// above the green raises the camera instead of driving it into the map.
    public func pose(atDistance distance: Double) -> FlyoverPose {
        let clamped = min(max(distance, 0), path.length)
        let current = path.point(at: clamped)
        let headingRad = path.heading(at: clamped) * .pi / 180
        let eye = (
            x: current.x - sin(headingRad) * Self.trailBehind,
            y: current.y - cos(headingRad) * Self.trailBehind
        )
        let targetDistance = min(clamped + Self.lookAhead, path.length)
        var target = path.point(at: targetDistance)

        var dx = target.x - eye.x
        var dy = target.y - eye.y
        var horizontal = hypot(dx, dy)
        if horizontal < 1 {
            dx = sin(headingRad)
            dy = cos(headingRad)
            horizontal = 1
        }
        let heading = FlyoverPath.headingDegrees(dx: dx, dy: dy)

        let groundAtEye = groundElevation(at: clamped - Self.trailBehind)
        let groundAtTarget = groundElevation(at: targetDistance)
        let altitude = max(Self.eyeHeight + (groundAtEye - groundAtTarget), Self.eyeHeight / 2)

        var pitch = atan2(horizontal, altitude) * 180 / .pi
        if pitch > Self.maxPitch {
            pitch = Self.maxPitch
            let reach = altitude * tan(Self.maxPitch * .pi / 180)
            target = (eye.x + dx / horizontal * reach, eye.y + dy / horizontal * reach)
        }

        return FlyoverPose(
            center: Sweref99TM.toWGS84(x: target.x, y: target.y),
            altitude: altitude,
            pitch: pitch,
            heading: heading
        )
    }
}

/// A flyover request for `CourseMapView`; applied once per `token` change.
public struct FlyoverCommand: Equatable, Sendable {
    public var plan: FlyoverPlan
    public var token: Int

    public init(plan: FlyoverPlan, token: Int) {
        self.plan = plan
        self.token = token
    }
}
