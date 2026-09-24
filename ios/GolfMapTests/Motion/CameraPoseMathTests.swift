import XCTest
@testable import GolfMap

/// Pins the `CMAttitude` convention and the §4.2 angle definitions with poses
/// derived by hand. Each matrix is written as the device axes in the
/// reference frame (X north, Y west, Z up), which is what the rows of
/// `CMAttitude.rotationMatrix` hold under the convention documented on
/// `CameraPoseMath`.
final class CameraPoseMathTests: XCTestCase {
    typealias V = CameraPoseMath.Vec3
    typealias M = CameraPoseMath.Mat3
    typealias Q = CameraPoseMath.Quat

    private let north = V(x: 1, y: 0, z: 0)
    private let south = V(x: -1, y: 0, z: 0)
    private let west = V(x: 0, y: 1, z: 0)
    private let east = V(x: 0, y: -1, z: 0)
    private let up = V(x: 0, y: 0, z: 1)

    private let tol = 1e-9

    private func rad(_ d: Double) -> Double { d * .pi / 180 }

    private func assertPose(
        _ p: CameraPoseMath.Pose, yaw: Double, pitch: Double, roll: Double,
        accuracy: Double = 1e-9, file: StaticString = #filePath, line: UInt = #line
    ) {
        var dyaw = abs(p.yawDeg - yaw).truncatingRemainder(dividingBy: 360)
        dyaw = min(dyaw, 360 - dyaw)
        XCTAssertLessThan(dyaw, accuracy, "yaw \(p.yawDeg) != \(yaw)", file: file, line: line)
        XCTAssertEqual(p.pitchDeg, pitch, accuracy: accuracy, "pitch", file: file, line: line)
        XCTAssertEqual(p.rollDeg, roll, accuracy: accuracy, "roll", file: file, line: line)
    }

    // MARK: - Hand-derived poses

    func testPortraitUprightLevelFacingNorthIsZero() {
        // Camera (-Z) looks north, so +Z points south. Top edge up, right edge east.
        let m = M(deviceX: east, deviceY: up, deviceZ: south)
        assertPose(CameraPoseMath.pose(rotationMatrix: m, imageUp: .plusY), yaw: 0, pitch: 0, roll: 0)
    }

    func testFacingEastIsYaw90() {
        // Camera looks east, +Z points west; the user's right is south.
        let m = M(deviceX: south, deviceY: up, deviceZ: west)
        assertPose(CameraPoseMath.pose(rotationMatrix: m, imageUp: .plusY), yaw: 90, pitch: 0, roll: 0)
    }

    func testFacingWestIsYaw270() {
        let m = M(deviceX: north, deviceY: up, deviceZ: east)
        assertPose(CameraPoseMath.pose(rotationMatrix: m, imageUp: .plusY), yaw: 270, pitch: 0, roll: 0)
    }

    func testTiltedUp10IsPitch10() {
        let c = cos(rad(10)), s = sin(rad(10))
        // Optical axis (cos10, 0, sin10); the top edge leans back toward south.
        let m = M(
            deviceX: east,
            deviceY: V(x: -s, y: 0, z: c),
            deviceZ: V(x: -c, y: 0, z: -s)
        )
        assertPose(CameraPoseMath.pose(rotationMatrix: m, imageUp: .plusY), yaw: 0, pitch: 10, roll: 0)
    }

    func testLyingFlatScreenUpIsPitchMinus90() {
        // Screen up: +Z up, camera looks down. Top edge north, right edge east.
        let m = M(deviceX: east, deviceY: north, deviceZ: up)
        let p = CameraPoseMath.pose(rotationMatrix: m, imageUp: .plusY)
        XCTAssertEqual(p.pitchDeg, -90, accuracy: tol)
    }

    func testLandscapeHomeRightIsLevelInLandscapeFrame() {
        // Home side right: the right edge (+X) points up, the top edge west.
        let m = M(deviceX: up, deviceY: west, deviceZ: south)
        assertPose(CameraPoseMath.pose(rotationMatrix: m, imageUp: .plusX), yaw: 0, pitch: 0, roll: 0)
        // The same hold read in the portrait frame is a 90° counterclockwise twist.
        assertPose(CameraPoseMath.pose(rotationMatrix: m, imageUp: .plusY), yaw: 0, pitch: 0, roll: -90)
    }

    func testLandscapeHomeLeftIsLevelInItsFrame() {
        // Home side left: -X points up, the top edge east.
        let m = M(deviceX: V(x: 0, y: 0, z: -1), deviceY: east, deviceZ: south)
        assertPose(CameraPoseMath.pose(rotationMatrix: m, imageUp: .minusX), yaw: 0, pitch: 0, roll: 0)
    }

    func testClockwiseTwist5IsRollPlus5() {
        // Facing north, twisted 5° clockwise as the user sees it: the top edge
        // leans toward east.
        let c = cos(rad(5)), s = sin(rad(5))
        let m = M(
            deviceX: V(x: 0, y: -c, z: -s),
            deviceY: V(x: 0, y: -s, z: c),
            deviceZ: south
        )
        assertPose(CameraPoseMath.pose(rotationMatrix: m, imageUp: .plusY), yaw: 0, pitch: 0, roll: 5)
    }

    func testUpsideDownPortraitIsLevelInItsFrame() {
        let m = M(deviceX: west, deviceY: V(x: 0, y: 0, z: -1), deviceZ: south)
        assertPose(CameraPoseMath.pose(rotationMatrix: m, imageUp: .minusY), yaw: 0, pitch: 0, roll: 0)
    }

    // MARK: - Quaternion convention

    func testQuaternionMatrixIsTransposeOfActiveRotation() {
        // Identity: device X north, Y west, Z up.
        let identity = CameraPoseMath.matrix(from: Q(w: 1, x: 0, y: 0, z: 0))
        XCTAssertLessThan(identity.maxAbsDifference(M(deviceX: north, deviceY: west, deviceZ: up)), tol)

        // Rotated 90° counterclockwise seen from above: X → west, Y → south.
        let ccw = CameraPoseMath.matrix(from: Q.aboutZ(.pi / 2))
        XCTAssertLessThan(ccw.maxAbsDifference(M(deviceX: west, deviceY: south, deviceZ: up)), tol)

        // Rotated 90° clockwise: flat, top edge north, right edge east.
        let cw = CameraPoseMath.matrix(from: Q.aboutZ(-.pi / 2))
        XCTAssertLessThan(cw.maxAbsDifference(M(deviceX: east, deviceY: north, deviceZ: up)), tol)
    }

    func testPortraitNorthQuaternionIsZeroPose() {
        // Hand-derived from R = [E U S] (columns): w = 0.5, x = 0.5, y = -0.5, z = -0.5.
        let q = Q(w: 0.5, x: 0.5, y: -0.5, z: -0.5)
        let m = CameraPoseMath.matrix(from: q)
        XCTAssertLessThan(m.maxAbsDifference(M(deviceX: east, deviceY: up, deviceZ: south)), tol)
        assertPose(CameraPoseMath.pose(quaternion: q, imageUp: .plusY), yaw: 0, pitch: 0, roll: 0)
        // Gravity for an upright portrait phone points down the -Y axis.
        let g = m.gravityInDevice
        XCTAssertEqual(g.x, 0, accuracy: tol)
        XCTAssertEqual(g.y, -1, accuracy: tol)
        XCTAssertEqual(g.z, 0, accuracy: tol)
    }

    // MARK: - Round trip

    /// Builds M from a target pose, then recovers the pose.
    private func matrix(yaw: Double, pitch: Double, roll: Double) -> M {
        let (y, p, r) = (rad(yaw), rad(pitch), rad(roll))
        let forward = V(x: cos(p) * cos(y), y: -cos(p) * sin(y), z: sin(p))
        let up0 = V(x: -sin(p) * cos(y), y: sin(p) * sin(y), z: cos(p))
        let right0 = forward.cross(up0)
        let imageUp = cos(r) * up0 + sin(r) * right0
        let deviceZ = -forward
        let deviceX = imageUp.cross(deviceZ)
        return M(deviceX: deviceX, deviceY: imageUp, deviceZ: deviceZ)
    }

    func testRoundTripAcrossPoses() {
        for yaw in stride(from: 0.0, to: 360, by: 37) {
            for pitch in [-80.0, -30, -5, 0, 12, 45, 80] {
                for roll in [-170.0, -45, -3, 0, 7, 90, 179] {
                    let p = CameraPoseMath.pose(rotationMatrix: matrix(yaw: yaw, pitch: pitch, roll: roll), imageUp: .plusY)
                    assertPose(p, yaw: yaw, pitch: pitch, roll: roll, accuracy: 1e-7)
                }
            }
        }
    }

    // MARK: - Declination

    func testDeclinationRotatesYawEastward() {
        let magneticNorth = Q(w: 0.5, x: 0.5, y: -0.5, z: -0.5)
        let trueQ = CameraPoseMath.applyingDeclination(magneticNorth, declinationDeg: 6)
        assertPose(CameraPoseMath.pose(quaternion: trueQ, imageUp: .plusY), yaw: 6, pitch: 0, roll: 0, accuracy: 1e-9)
        let westQ = CameraPoseMath.applyingDeclination(magneticNorth, declinationDeg: -4)
        assertPose(CameraPoseMath.pose(quaternion: westQ, imageUp: .plusY), yaw: 356, pitch: 0, roll: 0, accuracy: 1e-9)
    }

    // MARK: - Image up from gravity and EXIF

    func testImageUpFromGravity() {
        XCTAssertEqual(CameraPoseMath.ImageUp.from(gravity: V(x: 0, y: -1, z: 0)), .plusY)
        XCTAssertEqual(CameraPoseMath.ImageUp.from(gravity: V(x: 0, y: 1, z: 0)), .minusY)
        XCTAssertEqual(CameraPoseMath.ImageUp.from(gravity: V(x: -1, y: 0, z: 0)), .plusX)
        XCTAssertEqual(CameraPoseMath.ImageUp.from(gravity: V(x: 0.98, y: -0.2, z: 0)), .minusX)
        XCTAssertNil(CameraPoseMath.ImageUp.from(gravity: V(x: 0.1, y: -0.1, z: -0.99)))
    }

    func testExifOrientationRoundTrip() {
        for up in CameraPoseMath.ImageUp.allCases {
            XCTAssertEqual(CameraPoseMath.ImageUp(exifOrientation: up.exifOrientation), up)
        }
        XCTAssertEqual(CameraPoseMath.ImageUp.plusY.exifOrientation, 6)
        XCTAssertEqual(CameraPoseMath.ImageUp.plusX.exifOrientation, 1)
        XCTAssertNil(CameraPoseMath.ImageUp(exifOrientation: 0))
    }

    func testOrientedSizeSwapsForRotatedExif() {
        XCTAssertTrue(CameraPoseMath.orientedSize(pixelWidth: 4032, pixelHeight: 3024, exifOrientation: 6) == (3024, 4032))
        XCTAssertTrue(CameraPoseMath.orientedSize(pixelWidth: 4032, pixelHeight: 3024, exifOrientation: 1) == (4032, 3024))
        XCTAssertTrue(CameraPoseMath.orientedSize(pixelWidth: 4032, pixelHeight: 3024, exifOrientation: 3) == (4032, 3024))
    }

    // MARK: - Field of view

    func testFieldOfViewLandscapeAndPortrait() {
        let fov = 69.4
        let expectedShort = 2 * atan(tan(rad(fov / 2)) * 0.75) * 180 / .pi
        let land = CameraPoseMath.fieldOfView(longSideFovDeg: fov, width: 4032, height: 3024)
        XCTAssertEqual(land.hfovDeg, fov, accuracy: tol)
        XCTAssertEqual(land.vfovDeg, expectedShort, accuracy: tol)

        let port = CameraPoseMath.fieldOfView(longSideFovDeg: fov, width: 3024, height: 4032)
        XCTAssertEqual(port.hfovDeg, expectedShort, accuracy: tol)
        XCTAssertEqual(port.vfovDeg, fov, accuracy: tol)
        XCTAssertLessThan(port.hfovDeg, port.vfovDeg)
    }

    // MARK: - Shutter window

    func testShutterWindowTakesMedianOfLastWindow() {
        let base = Q(w: 0.5, x: 0.5, y: -0.5, z: -0.5)
        func yawed(_ deg: Double) -> Q { CameraPoseMath.applyingDeclination(base, declinationDeg: deg) }
        var samples: [CameraPoseMath.MotionSample] = []
        // Old samples outside the window at yaw 40 must be ignored.
        for i in 0..<10 {
            samples.append(.init(timestamp: Double(i) * 0.02, attitude: yawed(40), rotationRateRadS: 2))
        }
        // Window samples at yaw 10 with one outlier at 30; one sign-flipped copy.
        let t0 = 1.0
        for i in 0..<15 {
            var q = yawed(i == 7 ? 30 : 10)
            if i == 3 { q = Q(w: -q.w, x: -q.x, y: -q.y, z: -q.z) }
            samples.append(.init(timestamp: t0 + Double(i) * 0.02, attitude: q, rotationRateRadS: 0.02))
        }
        let now = t0 + 14 * 0.02
        let w = CameraPoseMath.shutterWindow(samples: samples, now: now, windowS: 0.3, maxRotationRateRadS: 0.1)
        XCTAssertNotNil(w)
        XCTAssertEqual(w?.sampleCount, 15)
        XCTAssertEqual(w?.isStationary, true)
        let pose = CameraPoseMath.pose(quaternion: w!.attitude, imageUp: .plusY)
        XCTAssertEqual(pose.yawDeg, 10, accuracy: 1e-6)
    }

    func testShutterWindowFlagsMotion() {
        let q = Q(w: 1, x: 0, y: 0, z: 0)
        let samples = (0..<20).map {
            CameraPoseMath.MotionSample(timestamp: Double($0) * 0.02, attitude: q, rotationRateRadS: $0 == 15 ? 0.4 : 0.01)
        }
        let w = CameraPoseMath.shutterWindow(samples: samples, now: 0.38, windowS: 0.3, maxRotationRateRadS: 0.1)
        XCTAssertEqual(w?.isStationary, false)
        XCTAssertEqual(w?.maxRotationRateRadS ?? 0, 0.4, accuracy: tol)
        XCTAssertNil(CameraPoseMath.shutterWindow(samples: [], now: 1, windowS: 0.3, maxRotationRateRadS: 0.1))
    }
}
