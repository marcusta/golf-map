import Foundation

/// Converts a CoreMotion attitude into the camera pose recorded with a
/// reference photo (docs/feature-reference-photos.md §4.2). Pure, no
/// CoreMotion import, so every convention is pinned by `CameraPoseMathTests`.
///
/// ## Frames
///
/// - Reference frame of `.xTrueNorthZVertical`: X points to true north, Z up,
///   Y = Z × X points west (right-handed "NWU").
/// - Device frame: +X to the right of the screen in portrait, +Y to the top
///   edge, +Z out of the screen toward the user. The back camera looks along
///   device -Z.
///
/// ## Verified convention
///
/// `CMAttitude.rotationMatrix` M maps reference vectors into device
/// coordinates, `v_dev = M · v_ref`. So row i of M is device axis i written in
/// the reference frame. `CMAttitude.quaternion` q is the device orientation in
/// the reference frame (Hamilton, active): its matrix R(q) maps device vectors
/// into the reference frame, so R(q) = Mᵀ. `matrix(from:)` implements that.
///
/// Evidence:
/// - Apple's pARk AR sample (`.xTrueNorthZVertical`) writes points of interest
///   as (north, -east, up) and multiplies them by the matrix built from
///   `rotationMatrix` to get device-space positions, which is v_dev = M · v_ref
///   in an NWU reference frame.
/// - Under this convention gravity in the device frame is M · (0, 0, -1) =
///   -(m13, m23, m33); under the transposed one it would be -(m31, m32, m33).
///   The two differ whenever the phone is tilted, so comparing with
///   `CMDeviceMotion.gravity` on a device separates them.
/// - The tests build M by hand from physical poses (the rows are the device
///   axes in NWU) and check yaw, pitch and roll for each case, and check that
///   `matrix(from:)` of a hand-written quaternion equals the hand-built M.
/// - On a device, `PhotoCaptureService` compares each sample's
///   `rotationMatrix` with `matrix(from: quaternion)` and `gravity` with
///   -(m13, m23, m33), and logs any mismatch. That is the only check against
///   the real CoreMotion output; the simulator has no device motion.
///
/// ## Angles (doc §4.2)
///
/// - yaw: azimuth of the optical axis (device -Z), clockwise from true north,
///   in [0, 360).
/// - pitch: optical axis angle above the horizontal, positive up, [-90, 90].
/// - roll: angle from world up, projected into the image plane, to the image's
///   up axis, positive clockwise as seen looking along the optical axis,
///   (-180, 180]. A photographer who twists the phone clockwise reads +roll.
///
/// The image up axis depends on how the phone was held (`ImageUp`), and is
/// read back from the EXIF orientation of the stored file, so width, height,
/// FOV and roll all describe the pixels after EXIF orientation is applied.
enum CameraPoseMath {

    // MARK: - Types

    struct Vec3: Sendable, Equatable {
        var x: Double
        var y: Double
        var z: Double

        static func + (a: Vec3, b: Vec3) -> Vec3 { Vec3(x: a.x + b.x, y: a.y + b.y, z: a.z + b.z) }
        static func * (s: Double, v: Vec3) -> Vec3 { Vec3(x: s * v.x, y: s * v.y, z: s * v.z) }
        static prefix func - (v: Vec3) -> Vec3 { Vec3(x: -v.x, y: -v.y, z: -v.z) }

        func dot(_ o: Vec3) -> Double { x * o.x + y * o.y + z * o.z }
        func cross(_ o: Vec3) -> Vec3 {
            Vec3(x: y * o.z - z * o.y, y: z * o.x - x * o.z, z: x * o.y - y * o.x)
        }
    }

    /// Unit quaternion, same component layout as `CMQuaternion`.
    struct Quat: Sendable, Equatable, Codable {
        var w: Double
        var x: Double
        var y: Double
        var z: Double

        var norm: Double { (w * w + x * x + y * y + z * z).squareRoot() }

        var normalized: Quat {
            let n = norm
            guard n > 0 else { return Quat(w: 1, x: 0, y: 0, z: 0) }
            return Quat(w: w / n, x: x / n, y: y / n, z: z / n)
        }

        func dot(_ o: Quat) -> Double { w * o.w + x * o.x + y * o.y + z * o.z }

        /// Hamilton product `self ⊗ o`.
        static func * (a: Quat, b: Quat) -> Quat {
            Quat(
                w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
                x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
                y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
                z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
            )
        }

        /// Rotation by `radians` about the reference Z (up) axis,
        /// counterclockwise seen from above.
        static func aboutZ(_ radians: Double) -> Quat {
            Quat(w: cos(radians / 2), x: 0, y: 0, z: sin(radians / 2))
        }
    }

    /// `CMRotationMatrix` layout: `m[row][col]` as `mRC`.
    struct Mat3: Sendable, Equatable {
        var m11, m12, m13: Double
        var m21, m22, m23: Double
        var m31, m32, m33: Double

        /// Builds M from the device axes written in the reference frame (NWU).
        init(deviceX: Vec3, deviceY: Vec3, deviceZ: Vec3) {
            m11 = deviceX.x; m12 = deviceX.y; m13 = deviceX.z
            m21 = deviceY.x; m22 = deviceY.y; m23 = deviceY.z
            m31 = deviceZ.x; m32 = deviceZ.y; m33 = deviceZ.z
        }

        init(m11: Double, m12: Double, m13: Double,
             m21: Double, m22: Double, m23: Double,
             m31: Double, m32: Double, m33: Double) {
            self.m11 = m11; self.m12 = m12; self.m13 = m13
            self.m21 = m21; self.m22 = m22; self.m23 = m23
            self.m31 = m31; self.m32 = m32; self.m33 = m33
        }

        var row1: Vec3 { Vec3(x: m11, y: m12, z: m13) }
        var row2: Vec3 { Vec3(x: m21, y: m22, z: m23) }
        var row3: Vec3 { Vec3(x: m31, y: m32, z: m33) }

        /// Gravity in the device frame, M · (0, 0, -1).
        var gravityInDevice: Vec3 { Vec3(x: -m13, y: -m23, z: -m33) }

        func maxAbsDifference(_ o: Mat3) -> Double {
            [m11 - o.m11, m12 - o.m12, m13 - o.m13,
             m21 - o.m21, m22 - o.m22, m23 - o.m23,
             m31 - o.m31, m32 - o.m32, m33 - o.m33].map(abs).max() ?? 0
        }
    }

    /// The device axis that points up in the stored image (after EXIF
    /// orientation). The back camera sensor's native orientation is landscape
    /// with the home side on the right, which is EXIF orientation 1.
    enum ImageUp: String, Sendable, Codable, CaseIterable {
        /// Portrait: the top edge is up. EXIF 6.
        case plusY
        /// Portrait upside down. EXIF 8.
        case minusY
        /// Landscape, home side on the right (top edge to the left). EXIF 1.
        case plusX
        /// Landscape, home side on the left (top edge to the right). EXIF 3.
        case minusX

        var isPortrait: Bool { self == .plusY || self == .minusY }

        /// `CGImagePropertyOrientation` raw value a back-camera HEIC carries
        /// for this hold.
        var exifOrientation: UInt32 {
            switch self {
            case .plusX: return 1
            case .minusX: return 3
            case .plusY: return 6
            case .minusY: return 8
            }
        }

        /// `AVCaptureConnection.videoRotationAngle` that makes the photo
        /// output tag the file with `exifOrientation`.
        var videoRotationAngle: Double {
            switch self {
            case .plusX: return 0
            case .plusY: return 90
            case .minusX: return 180
            case .minusY: return 270
            }
        }

        /// Maps a stored EXIF orientation back to the hold. Mirrored values
        /// (2, 4, 5, 7) never come from the back camera; they map to the
        /// unmirrored orientation with the same up edge.
        init?(exifOrientation: UInt32) {
            switch exifOrientation {
            case 1, 2: self = .plusX
            case 3, 4: self = .minusX
            case 6, 5: self = .plusY
            case 8, 7: self = .minusY
            default: return nil
            }
        }

        /// The up axis from gravity in the device frame: the in-plane device
        /// axis most opposite to gravity. Returns nil when the phone is close
        /// to flat (in-plane gravity under `minInPlaneGravity`), so the caller
        /// keeps its previous hold.
        static func from(gravity g: Vec3, minInPlaneGravity: Double = 0.35) -> ImageUp? {
            let upX = -g.x
            let upY = -g.y
            guard (upX * upX + upY * upY).squareRoot() >= minInPlaneGravity else { return nil }
            if abs(upY) >= abs(upX) {
                return upY >= 0 ? .plusY : .minusY
            }
            return upX >= 0 ? .plusX : .minusX
        }

        fileprivate func axis(in m: Mat3) -> Vec3 {
            switch self {
            case .plusY: return m.row2
            case .minusY: return -m.row2
            case .plusX: return m.row1
            case .minusX: return -m.row1
            }
        }
    }

    struct Pose: Sendable, Equatable {
        var yawDeg: Double
        var pitchDeg: Double
        var rollDeg: Double
    }

    // MARK: - Attitude to pose

    /// M = R(q)ᵀ for a `CMAttitude.quaternion`.
    static func matrix(from q: Quat) -> Mat3 {
        let q = q.normalized
        let (w, x, y, z) = (q.w, q.x, q.y, q.z)
        // R(q), device → reference.
        let r11 = 1 - 2 * (y * y + z * z), r12 = 2 * (x * y - w * z), r13 = 2 * (x * z + w * y)
        let r21 = 2 * (x * y + w * z), r22 = 1 - 2 * (x * x + z * z), r23 = 2 * (y * z - w * x)
        let r31 = 2 * (x * z - w * y), r32 = 2 * (y * z + w * x), r33 = 1 - 2 * (x * x + y * y)
        return Mat3(
            m11: r11, m12: r21, m13: r31,
            m21: r12, m22: r22, m23: r32,
            m31: r13, m32: r23, m33: r33
        )
    }

    static func pose(quaternion: Quat, imageUp: ImageUp) -> Pose {
        pose(rotationMatrix: matrix(from: quaternion), imageUp: imageUp)
    }

    static func pose(rotationMatrix m: Mat3, imageUp: ImageUp) -> Pose {
        // Optical axis (device -Z) and image up, in NWU.
        let forward = -m.row3
        let up = imageUp.axis(in: m)
        let right = forward.cross(up)

        let east = -forward.y
        var yaw = atan2(east, forward.x) * 180 / .pi
        if yaw < 0 { yaw += 360 }
        if yaw >= 360 { yaw -= 360 }

        let pitch = asin(max(-1, min(1, forward.z))) * 180 / .pi

        // World up (0, 0, 1) in image coordinates is (right.z, up.z). It sits
        // atan2(right.z, up.z) clockwise from image up, so image up sits the
        // same angle counterclockwise from world up.
        var roll = atan2(-right.z, up.z) * 180 / .pi
        if roll <= -180 { roll += 360 }
        return Pose(yawDeg: yaw, pitchDeg: pitch, rollDeg: roll)
    }

    // MARK: - Magnetic fallback

    /// Rotates an `.xMagneticNorthZVertical` attitude into the true-north
    /// frame. `declinationDeg` is true minus magnetic heading (east positive).
    /// A direction at magnetic azimuth a has true azimuth a + D, which is a
    /// clockwise turn seen from above, so the correction is `aboutZ(-D)`.
    static func applyingDeclination(_ q: Quat, declinationDeg: Double) -> Quat {
        (Quat.aboutZ(-declinationDeg * .pi / 180) * q).normalized
    }

    // MARK: - Shutter window

    struct MotionSample: Sendable, Equatable {
        /// Seconds, any monotonic clock (`CMDeviceMotion.timestamp`).
        var timestamp: Double
        var attitude: Quat
        /// |rotationRate| in rad/s.
        var rotationRateRadS: Double
    }

    struct ShutterWindow: Sendable, Equatable {
        var attitude: Quat
        var sampleCount: Int
        var maxRotationRateRadS: Double
        var isStationary: Bool
    }

    /// Median attitude over the last `windowS` seconds before `now`, and
    /// whether the rotation rate stayed at or under `maxRotationRateRadS`.
    /// Quaternions are sign-aligned to the newest sample, then each component
    /// takes its median and the result is renormalized. For the spread of a
    /// hand-held phone (a few degrees) this matches the rotation median to
    /// well under 0.1°. Returns nil when no sample falls in the window.
    static func shutterWindow(
        samples: [MotionSample],
        now: Double,
        windowS: Double,
        maxRotationRateRadS: Double
    ) -> ShutterWindow? {
        let window = samples.filter { $0.timestamp <= now && $0.timestamp >= now - windowS }
        guard let newest = window.max(by: { $0.timestamp < $1.timestamp }) else { return nil }
        let aligned = window.map { s -> Quat in
            s.attitude.dot(newest.attitude) < 0
                ? Quat(w: -s.attitude.w, x: -s.attitude.x, y: -s.attitude.y, z: -s.attitude.z)
                : s.attitude
        }
        let q = Quat(
            w: median(aligned.map(\.w)),
            x: median(aligned.map(\.x)),
            y: median(aligned.map(\.y)),
            z: median(aligned.map(\.z))
        ).normalized
        let maxRate = window.map(\.rotationRateRadS).max() ?? 0
        return ShutterWindow(
            attitude: q,
            sampleCount: window.count,
            maxRotationRateRadS: maxRate,
            isStationary: maxRate <= maxRotationRateRadS
        )
    }

    static func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let s = values.sorted()
        let mid = s.count / 2
        return s.count % 2 == 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }

    // MARK: - Field of view

    /// Horizontal and vertical FOV of an oriented image. `longSideFovDeg` is
    /// `AVCaptureDevice.activeFormat.videoFieldOfView`: the horizontal FOV of
    /// the landscape sensor frame at zoom 1. The photo spans the full sensor
    /// width, so that angle belongs to the image's long side; the short side
    /// follows from the pinhole model, 2·atan(tan(long/2) · short/long).
    static func fieldOfView(
        longSideFovDeg: Double,
        width: Int,
        height: Int
    ) -> (hfovDeg: Double, vfovDeg: Double) {
        let long = Double(max(width, height))
        let short = Double(min(width, height))
        let halfLong = longSideFovDeg / 2 * .pi / 180
        let shortFov = 2 * atan(tan(halfLong) * short / long) * 180 / .pi
        return width >= height
            ? (longSideFovDeg, shortFov)
            : (shortFov, longSideFovDeg)
    }

    /// Size after EXIF orientation: orientations 5–8 swap the axes.
    static func orientedSize(pixelWidth: Int, pixelHeight: Int, exifOrientation: UInt32) -> (width: Int, height: Int) {
        (5...8).contains(exifOrientation)
            ? (pixelHeight, pixelWidth)
            : (pixelWidth, pixelHeight)
    }
}
