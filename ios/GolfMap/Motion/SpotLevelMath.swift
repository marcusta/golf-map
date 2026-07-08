import Foundation

/// Pure spot-level tilt math — NO CoreMotion types. Given a stream of gravity
/// samples (device-frame unit vectors) plus the device heading, it derives the
/// green's local slope and the downhill fall-line bearing, with settling
/// statistics the capture UI gates on.
///
/// The phone lies FLAT on the green, screen up. In the device frame gravity is
/// a unit vector pointing toward earth's centre; when the phone is perfectly
/// level that is (0, 0, −1) — straight out the back of the screen. Two readings
/// come out of one gravity vector:
///
///  - **Tilt magnitude** — the angle between measured gravity and the flat
///    reference (0, 0, −1). tan(tilt) = |horizontal component| / |z|, so
///    slope fraction = |(gx, gy)| / |gz| (rise/run), slope % = ×100. This is
///    gravity-anchored: it does NOT depend on heading, which is why the
///    magnitude is the trustworthy half of the reading (doc §4.2).
///
///  - **Fall-line bearing (downhill)** — the horizontal projection of gravity
///    (gx, gy) points downhill in the *device* plane; rotating it into the
///    world frame by the device heading gives a compass bearing. Heading is the
///    weak link (compass accuracy), so the consumer down-weights the bearing,
///    not the magnitude (doc §4.2 / green-scan-payload contract).
///
/// Everything here is fed plain vectors + angles so it is exhaustively
/// unit-testable with synthetic samples — the CoreMotion wrapper
/// (`SpotLevelCapture`) is a thin adapter on top.
///
/// Conventions:
///  - Device frame: +x right, +y up (toward the top edge / status bar), +z out
///    of the screen toward the user — the CoreMotion attitude reference frame.
///  - Bearings: compass degrees, 0 = north, clockwise, wrapped to [0, 360).
///  - `slopePct` is rise/run × 100 (matches `PlaysLike` / `GreenSurface`).
public enum SpotLevelMath {

    /// One instantaneous sample: the device-frame gravity unit vector plus the
    /// device heading (compass degrees toward which the device's +y axis / top
    /// edge points, magnetic or true north depending on the reference frame).
    public struct Sample: Sendable, Equatable {
        /// Device-frame gravity, unit-length pointing toward earth (CoreMotion
        /// `gravity`). Flat screen-up ≈ (0, 0, −1).
        public var gx: Double
        public var gy: Double
        public var gz: Double
        /// Compass heading of the device's +y (top) axis, degrees. Feeds the
        /// fall-line rotation into the world frame.
        public var headingDeg: Double

        public init(gx: Double, gy: Double, gz: Double, headingDeg: Double) {
            self.gx = gx
            self.gy = gy
            self.gz = gz
            self.headingDeg = headingDeg
        }
    }

    /// The derived reading over a sampling window.
    public struct Reading: Sendable, Equatable {
        /// Slope magnitude, rise/run × 100, unsigned.
        public var slopePct: Double
        /// DOWNHILL compass bearing (where a released ball rolls), degrees
        /// [0, 360). Undefined for a dead-flat surface — reported as 0 with a
        /// near-zero `slopePct`; callers should treat sub-threshold slopes as
        /// directionless.
        public var fallLineBearingDeg: Double
        /// Std-dev of per-sample tilt angle over the window, degrees. The
        /// settle gate: a reading that won't hold still has a high value.
        public var tiltStdDeg: Double
        /// Mean tilt angle over the window, degrees (informational; the
        /// slope is derived from the mean gravity vector, not this).
        public var tiltMeanDeg: Double
        /// Number of samples that fed the reading.
        public var sampleCount: Int
        /// Window duration, seconds.
        public var durationS: Double
    }

    /// Reduce a window of samples to a single reading. The slope + fall line are
    /// computed from the MEAN gravity vector (averaging suppresses per-sample
    /// IMU noise before the nonlinear atan), while `tiltStdDeg` measures the
    /// spread of the per-sample tilt angles (the settle signal).
    ///
    /// `durationS` is passed in (the capture layer times the window); an empty
    /// window yields a flat, zero-count reading.
    public static func reduce(_ samples: [Sample], durationS: Double) -> Reading {
        guard !samples.isEmpty else {
            return Reading(
                slopePct: 0, fallLineBearingDeg: 0, tiltStdDeg: 0,
                tiltMeanDeg: 0, sampleCount: 0, durationS: durationS
            )
        }

        // Mean gravity vector — average first, derive slope from the mean.
        var mx = 0.0, my = 0.0, mz = 0.0
        // Per-sample tilt angles for the settle statistics.
        var tilts: [Double] = []
        tilts.reserveCapacity(samples.count)
        for s in samples {
            mx += s.gx
            my += s.gy
            mz += s.gz
            tilts.append(tiltDegrees(gx: s.gx, gy: s.gy, gz: s.gz))
        }
        let n = Double(samples.count)
        mx /= n; my /= n; mz /= n

        let slopeFraction = slopeFractionFromGravity(gx: mx, gy: my, gz: mz)
        let slopePct = slopeFraction * 100

        // Fall line from the mean gravity's horizontal projection, rotated into
        // the world frame by the mean heading. Averaging headings must wrap, so
        // use the circular mean.
        let meanHeading = circularMeanDegrees(samples.map(\.headingDeg))
        let fallLine = fallLineBearingDegrees(gx: mx, gy: my, headingDeg: meanHeading)

        let tiltMean = tilts.reduce(0, +) / n
        let variance = tilts.reduce(0) { $0 + ($1 - tiltMean) * ($1 - tiltMean) } / n
        let tiltStd = variance.squareRoot()

        return Reading(
            slopePct: slopePct,
            fallLineBearingDeg: fallLine,
            tiltStdDeg: tiltStd,
            tiltMeanDeg: tiltMean,
            sampleCount: samples.count,
            durationS: durationS
        )
    }

    // MARK: - Primitives (each independently testable)

    /// Slope fraction (rise/run) from a device-frame gravity vector: the ratio
    /// of the horizontal component to the vertical (|z|) component. tan of the
    /// tilt angle. Guards a degenerate all-zero vector to 0.
    public static func slopeFractionFromGravity(gx: Double, gy: Double, gz: Double) -> Double {
        let horizontal = (gx * gx + gy * gy).squareRoot()
        let vertical = abs(gz)
        guard vertical > 0 else { return horizontal > 0 ? .infinity : 0 }
        return horizontal / vertical
    }

    /// Tilt angle of the phone from flat, degrees: the angle between the
    /// gravity vector and the device −z axis (0, 0, −1). Uses atan2 of the
    /// horizontal magnitude over |z| so it is well-behaved near vertical.
    public static func tiltDegrees(gx: Double, gy: Double, gz: Double) -> Double {
        let horizontal = (gx * gx + gy * gy).squareRoot()
        return atan2(horizontal, abs(gz)) * 180 / .pi
    }

    /// The DOWNHILL compass bearing from a device-frame gravity horizontal
    /// projection (gx, gy) and the device heading.
    ///
    /// (gx, gy) already points downhill in the device plane (gravity's
    /// in-screen shadow). The device +y axis points at `headingDeg` on the
    /// compass; +x is 90° clockwise of it (to the right of the top edge). So a
    /// device-plane vector (gx, gy) maps to a compass bearing of
    /// `headingDeg + atan2(gx, gy)` — atan2(east, north) in the device's own
    /// axes, offset by where north sits. Wrapped to [0, 360).
    public static func fallLineBearingDegrees(gx: Double, gy: Double, headingDeg: Double) -> Double {
        // atan2(x, y): angle of the (x, y) vector measured clockwise from +y,
        // i.e. the device-local "bearing" of the downhill direction.
        let localBearing = atan2(gx, gy) * 180 / .pi
        return wrap360(headingDeg + localBearing)
    }

    /// Circular mean of a set of compass bearings (degrees), robust to the
    /// 359°/1° wrap. Empty → 0.
    public static func circularMeanDegrees(_ degrees: [Double]) -> Double {
        guard !degrees.isEmpty else { return 0 }
        var sx = 0.0, sy = 0.0
        for d in degrees {
            let r = d * .pi / 180
            sx += cos(r)
            sy += sin(r)
        }
        guard sx != 0 || sy != 0 else { return 0 }
        return wrap360(atan2(sy, sx) * 180 / .pi)
    }

    /// Wrap an angle in degrees to [0, 360). A value a hair under 360 (from a
    /// near-−0 input) folds to 0 rather than 359.999… so quadrant boundaries
    /// read cleanly.
    public static func wrap360(_ deg: Double) -> Double {
        var m = deg.truncatingRemainder(dividingBy: 360)
        if m < 0 { m += 360 }
        if m >= 360 - 1e-9 { m = 0 }
        return m
    }
}
