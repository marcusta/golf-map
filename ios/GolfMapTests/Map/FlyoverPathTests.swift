import XCTest
@testable import GolfMap

/// The pure flyover maths: path construction (straight and through aim
/// points), the trailing-eye / look-ahead pose with the 60° pitch cap, the
/// ground-profile altitude correction, and the trapezoidal timing.
final class FlyoverPathTests: XCTestCase {

    private let tee = LatLon(lat: 58.3600, lon: 15.7100)

    /// A point `east`/`north` planar metres (SWEREF) from `base`.
    private func offset(from base: LatLon, east: Double, north: Double) -> LatLon {
        let p = Sweref99TM.fromWGS84(base)
        return Sweref99TM.toWGS84(x: p.x + east, y: p.y + north)
    }

    private func planar(_ ll: LatLon) -> (x: Double, y: Double) {
        let p = Sweref99TM.fromWGS84(ll)
        return (p.x, p.y)
    }

    private func meters(_ a: LatLon, _ b: LatLon) -> Double {
        Distance.planarMeters(a, b)
    }

    /// Smallest angular difference between two compass headings.
    private func headingGap(_ a: Double, _ b: Double) -> Double {
        let raw = abs(a - b).truncatingRemainder(dividingBy: 360)
        return raw > 180 ? 360 - raw : raw
    }

    // MARK: - Path

    func testStraightPathLengthMidpointAndHeading() throws {
        let green = offset(from: tee, east: 0, north: 300)
        let path = try XCTUnwrap(FlyoverPath.build(waypoints: [tee, green]))

        XCTAssertEqual(path.length, 300, accuracy: 0.01)
        XCTAssertEqual(headingGap(path.heading(at: 0), 0), 0, accuracy: 0.01)
        XCTAssertEqual(headingGap(path.heading(at: 150), 0), 0, accuracy: 0.01)
        let mid = path.coordinate(at: 150)
        XCTAssertEqual(meters(mid, offset(from: tee, east: 0, north: 150)), 0, accuracy: 0.05)
        // Ends land exactly on the waypoints.
        XCTAssertEqual(meters(path.coordinate(at: 0), tee), 0, accuracy: 0.01)
        XCTAssertEqual(meters(path.coordinate(at: path.length), green), 0, accuracy: 0.01)
    }

    func testHeadingIsCompassClockwiseFromNorth() throws {
        let east = try XCTUnwrap(FlyoverPath.build(waypoints: [tee, offset(from: tee, east: 100, north: 0)]))
        XCTAssertEqual(east.heading(at: 50), 90, accuracy: 0.01)
        let southWest = try XCTUnwrap(
            FlyoverPath.build(waypoints: [tee, offset(from: tee, east: -100, north: -100)])
        )
        XCTAssertEqual(southWest.heading(at: 50), 225, accuracy: 0.01)
    }

    func testDoglegPassesThroughAimPointAndIsLongerThanStraightLine() throws {
        let aim = offset(from: tee, east: 0, north: 200)
        let green = offset(from: tee, east: 120, north: 320)
        let path = try XCTUnwrap(FlyoverPath.build(waypoints: [tee, aim, green]))

        XCTAssertGreaterThan(path.length, meters(tee, green))
        // The spline interpolates its control points: one vertex sits on the aim.
        let aimP = planar(aim)
        let nearest = path.vertices.map { hypot($0.x - aimP.x, $0.y - aimP.y) }.min() ?? .infinity
        XCTAssertEqual(nearest, 0, accuracy: 0.01)
        // Smooth: the heading turns gradually, never jumps the full corner in
        // one sample.
        var maxTurn = 0.0
        var d = 5.0
        while d < path.length - 5 {
            maxTurn = max(maxTurn, headingGap(path.heading(at: d), path.heading(at: d + 5)))
            d += 5
        }
        XCTAssertLessThan(maxTurn, 15)
        // Vertex distances are monotonic.
        for (a, b) in zip(path.vertices, path.vertices.dropFirst()) {
            XCTAssertLessThanOrEqual(a.distance, b.distance)
        }
    }

    func testPathExtendsStraightBeyondBothEnds() throws {
        let path = try XCTUnwrap(FlyoverPath.build(waypoints: [tee, offset(from: tee, east: 0, north: 300)]))
        let behind = path.point(at: -80)
        let start = path.point(at: 0)
        XCTAssertEqual(start.y - behind.y, 80, accuracy: 0.01)
        XCTAssertEqual(start.x - behind.x, 0, accuracy: 0.01)
        let past = path.point(at: 350)
        XCTAssertEqual(past.y - start.y, 350, accuracy: 0.01)
    }

    func testDegenerateWaypointsGiveNoPath() {
        XCTAssertNil(FlyoverPath.build(waypoints: []))
        XCTAssertNil(FlyoverPath.build(waypoints: [tee]))
        XCTAssertNil(FlyoverPath.build(waypoints: [tee, tee]))
        // Two points within the 0.5 m collapse threshold.
        XCTAssertNil(FlyoverPath.build(waypoints: [tee, offset(from: tee, east: 0.2, north: 0.2)]))
    }

    // MARK: - Pose

    private func flatPlan(length: Double) throws -> FlyoverPlan {
        let path = try XCTUnwrap(FlyoverPath.build(waypoints: [tee, offset(from: tee, east: 0, north: length)]))
        return FlyoverPlan(path: path, groundProfile: [])
    }

    func testPoseTrailsBehindLooksAheadAndCapsPitch() throws {
        let plan = try flatPlan(length: 400)
        let pose = plan.pose(atDistance: 100)

        XCTAssertEqual(headingGap(pose.heading, 0), 0, accuracy: 0.01)
        XCTAssertEqual(pose.altitude, FlyoverPlan.eyeHeight, accuracy: 1e-9)
        // Geometric pitch atan(200 / 45) = 77° exceeds the cap → 60°, and the
        // look-at point is pulled back to 45·tan(60°) ≈ 77.9 m from the eye,
        // which sits 80 m behind the path point: centre ≈ 100 − 80 + 77.9.
        XCTAssertEqual(pose.pitch, FlyoverPlan.maxPitch, accuracy: 1e-9)
        let expectedCentre = offset(from: tee, east: 0, north: 20 + 45 * tan(60 * Double.pi / 180))
        XCTAssertEqual(meters(pose.center, expectedCentre), 0, accuracy: 0.05)
    }

    func testEndPoseLooksAtGreenFromBehind() throws {
        let plan = try flatPlan(length: 400)
        let green = offset(from: tee, east: 0, north: 400)
        let pose = plan.pose(atDistance: plan.path.length)

        XCTAssertEqual(headingGap(pose.heading, 0), 0, accuracy: 0.01)
        // Eye 80 m short of the green, pitch capped: the centre lands 77.9 m
        // ahead of the eye, i.e. about 2 m short of the green centre.
        let eyeToCentre = 45 * tan(60 * Double.pi / 180)
        XCTAssertEqual(meters(pose.center, green), 80 - eyeToCentre, accuracy: 0.05)
        XCTAssertEqual(pose.pitch, FlyoverPlan.maxPitch, accuracy: 1e-9)
        // The hold reuses the end pose.
        XCTAssertEqual(plan.pose(atTime: plan.totalDuration), pose)
        XCTAssertEqual(plan.pose(atTime: plan.flightDuration + 0.5), pose)
    }

    func testPoseHeadingFollowsDogleg() throws {
        let aim = offset(from: tee, east: 0, north: 200)
        let green = offset(from: tee, east: 150, north: 350)
        let path = try XCTUnwrap(FlyoverPath.build(waypoints: [tee, aim, green]))
        let plan = FlyoverPlan(path: path, groundProfile: [])

        // Heading turns towards the green (east of north) after the corner.
        let before = headingGap(plan.pose(atDistance: 60).heading, 0)
        let after = plan.pose(atDistance: 280).heading
        XCTAssertLessThan(before, 25)
        XCTAssertGreaterThan(after, 30)
        XCTAssertLessThan(after, 60)
    }

    func testAltitudeRisesWhenEyeGroundIsAboveTargetGround() throws {
        let path = try XCTUnwrap(FlyoverPath.build(waypoints: [tee, offset(from: tee, east: 0, north: 300)]))
        // Profile from −80 m to 300 m every 10 m: 80 m at the tee end sloping
        // down to 50 m at the green.
        let distances = FlyoverPlan.profileDistances(for: path)
        XCTAssertEqual(distances.first, -FlyoverPlan.trailBehind)
        XCTAssertEqual(distances.last, path.length)
        let profile = distances.map { 80 - 30 * ($0 + 80) / 380 }
        let plan = FlyoverPlan(path: path, groundProfile: profile)

        XCTAssertEqual(plan.groundElevation(at: -80), 80, accuracy: 1e-9)
        XCTAssertEqual(plan.groundElevation(at: 300), 50, accuracy: 1e-9)
        XCTAssertEqual(plan.groundElevation(at: -200), 80, accuracy: 1e-9) // clamped
        XCTAssertEqual(plan.groundElevation(at: 110), 65, accuracy: 1e-9) // interpolated

        let pose = plan.pose(atDistance: 100)
        let eyeGround = plan.groundElevation(at: 20)
        let targetGround = plan.groundElevation(at: 220)
        XCTAssertEqual(pose.altitude, FlyoverPlan.eyeHeight + (eyeGround - targetGround), accuracy: 1e-9)
        XCTAssertGreaterThan(pose.altitude, FlyoverPlan.eyeHeight)
    }

    func testAltitudeNeverDropsBelowHalfEyeHeight() throws {
        let path = try XCTUnwrap(FlyoverPath.build(waypoints: [tee, offset(from: tee, east: 0, north: 300)]))
        let distances = FlyoverPlan.profileDistances(for: path)
        // Steep uphill: 0 m at the tee, 100 m at the green.
        let profile = distances.map { 100 * ($0 + 80) / 380 }
        let plan = FlyoverPlan(path: path, groundProfile: profile)
        let pose = plan.pose(atDistance: 100)
        XCTAssertEqual(pose.altitude, FlyoverPlan.eyeHeight / 2, accuracy: 1e-9)
    }

    func testMissingElevationSamplesTakeNearestKnownValue() throws {
        let plan = try FlyoverPlan(
            path: XCTUnwrap(FlyoverPath.build(waypoints: [tee, offset(from: tee, east: 0, north: 40)])),
            groundElevations: [nil, 10, nil, nil, 30, nil]
        )
        XCTAssertEqual(plan.groundProfile, [10, 10, 10, 30, 30, 30])
        let flat = try FlyoverPlan(
            path: XCTUnwrap(FlyoverPath.build(waypoints: [tee, offset(from: tee, east: 0, north: 40)])),
            groundElevations: [nil, nil]
        )
        XCTAssertEqual(flat.groundProfile, [0, 0])
        XCTAssertEqual(flat.pose(atDistance: 10).altitude, FlyoverPlan.eyeHeight, accuracy: 1e-9)
    }

    // MARK: - Timing

    func testThreeHundredMetresTakesEightSeconds() throws {
        let plan = try flatPlan(length: 300)
        // The projection round trip leaves the path a fraction of a millimetre
        // off 300 m, hence the loose tolerance on the time.
        XCTAssertEqual(plan.flightDuration, 8, accuracy: 1e-3)
        XCTAssertEqual(plan.totalDuration, plan.flightDuration + FlyoverPlan.holdDuration, accuracy: 1e-9)
        XCTAssertEqual(plan.distance(atTime: 0), 0)
        XCTAssertEqual(plan.distance(atTime: plan.flightDuration), plan.path.length, accuracy: 1e-9)
        XCTAssertEqual(plan.distance(atTime: plan.flightDuration + 1), plan.path.length, accuracy: 1e-9)
        XCTAssertEqual(plan.distance(atTime: -1), 0)
    }

    func testShortHoleGetsMinimumDuration() throws {
        let plan = try flatPlan(length: 60)
        XCTAssertEqual(plan.flightDuration, FlyoverPlan.minimumFlightDuration, accuracy: 1e-9)
    }

    func testDistanceIsContinuousMonotonicAndRamped() throws {
        let plan = try flatPlan(length: 300)
        var previous = 0.0
        var t = 0.0
        var maxStep = 0.0
        while t <= plan.flightDuration {
            let d = plan.distance(atTime: t)
            XCTAssertGreaterThanOrEqual(d, previous - 1e-9)
            maxStep = max(maxStep, d - previous)
            previous = d
            t += 0.05
        }
        // No jump larger than the peak speed allows in one 50 ms step:
        // peak = 300 / (8 − 1.5) ≈ 46 m/s → 2.3 m.
        XCTAssertLessThan(maxStep, 2.4)
        // Slow start and slow finish relative to the cruise.
        let startStep = plan.distance(atTime: 0.1) - plan.distance(atTime: 0)
        let cruiseStep = plan.distance(atTime: 4.1) - plan.distance(atTime: 4.0)
        let endStep = plan.distance(atTime: 8.0) - plan.distance(atTime: 7.9)
        XCTAssertLessThan(startStep, cruiseStep / 4)
        XCTAssertLessThan(endStep, cruiseStep / 4)
        // Cruise speed is the trapezoid's peak.
        XCTAssertEqual(cruiseStep / 0.1, 300 / (8 - FlyoverPlan.rampDuration), accuracy: 0.01)
    }
}
