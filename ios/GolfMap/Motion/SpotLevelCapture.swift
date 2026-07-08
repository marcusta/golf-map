import CoreMotion
import Observation
import QuartzCore

/// Thin CoreMotion wrapper that drives a spot-level capture: phone laid flat on
/// the green, ~1.5 s of settled samples, then a `SpotLevelMath.Reading` and a
/// verdict. All the geometry lives in `SpotLevelMath` (pure, fully tested);
/// this layer just adapts `CMDeviceMotion` into `SpotLevelMath.Sample`s, runs
/// the settle gate and timing, and publishes observable state to the UI.
///
/// Reference frame: `.xMagneticNorthZVertical` device motion, so `heading`
/// (yaw about vertical) is a compass bearing and `gravity` is gravity-anchored
/// — exactly the two inputs the math needs. Magnetic (not true) north keeps the
/// capture working without a location fix; the payload records
/// `headingAccuracyDeg` so the consumer can down-weight the bearing.
///
/// Verdict thresholds (gate the capture UI, doc §4.2 / green-scan-payload):
///  - settled (green): tilt std-dev ≤ `greenTiltStdDeg` over the window.
///  - marginal (yellow): ≤ `yellowTiltStdDeg`.
///  - refuse (red): won't settle, or the compass accuracy is unusable.
@MainActor
@Observable
final class SpotLevelCapture {

    // MARK: - Tunable thresholds

    /// Tilt std-dev (deg) at/under which a window is a confident (green) read.
    nonisolated static let greenTiltStdDeg = 0.02
    /// Tilt std-dev (deg) at/under which a window is marginal (yellow).
    nonisolated static let yellowTiltStdDeg = 0.05
    /// Heading accuracy (deg) worse than this refuses the reading outright — a
    /// wild compass makes the fall-line bearing meaningless. Generous because
    /// the consumer already down-weights the bearing; this only rejects the
    /// truly-uncalibrated compass (CoreMotion reports -1 when unknown).
    nonisolated static let maxHeadingAccuracyDeg = 40.0
    /// Sampling window length once settled.
    nonisolated static let windowDurationS = 1.5
    /// Live-tilt smoothing / settle-gate window kept before the capture window
    /// starts (recent samples used to decide "is it holding still?").
    nonisolated static let settleGateSampleCount = 15
    /// Device-motion update rate (Hz). 1.5 s × 90 Hz ≈ 135 samples.
    nonisolated static let updateHz = 90.0

    // MARK: - Observable live state

    /// Capture phase for the UI.
    enum Phase: Equatable {
        /// Not running.
        case idle
        /// Waiting for the phone to settle flat and still.
        case settling
        /// Collecting the timed window.
        case capturing
        /// Finished — `reading`/`verdict` are populated.
        case done
        /// CoreMotion unavailable / not permitted.
        case unavailable
    }

    private(set) var phase: Phase = .idle
    /// Live tilt magnitude (deg) for the on-screen bubble, updated every frame.
    private(set) var liveTiltDeg: Double = 0
    /// Live smoothed slope % for the readout.
    private(set) var liveSlopePct: Double = 0
    /// Live fall-line bearing (deg) for the readout.
    private(set) var liveFallLineDeg: Double = 0
    /// True once the recent samples are holding still (settle gate passed).
    private(set) var isSettled = false
    /// The final reduced reading, once `phase == .done`.
    private(set) var reading: SpotLevelMath.Reading?
    /// The verdict for the final reading.
    private(set) var verdict: GreenScanVerdict?
    /// Latest heading accuracy (deg), or nil when unknown/negative.
    private(set) var headingAccuracyDeg: Double?

    // MARK: - Private

    @ObservationIgnored private let motion: CMMotionManager
    @ObservationIgnored private let queue = OperationQueue()
    /// Recent samples for the settle gate (bounded ring).
    @ObservationIgnored private var recent: [SpotLevelMath.Sample] = []
    /// Samples collected during the timed capture window.
    @ObservationIgnored private var window: [SpotLevelMath.Sample] = []
    @ObservationIgnored private var windowStart: CFTimeInterval?

    init(motionManager: CMMotionManager = CMMotionManager()) {
        self.motion = motionManager
        queue.maxConcurrentOperationCount = 1
        queue.name = "SpotLevelCapture"
    }

    // MARK: - Control

    /// Begin a capture: start device motion, gate on settling, then collect the
    /// timed window. Idempotent while already running.
    func start() {
        guard phase == .idle || phase == .done else { return }
        guard motion.isDeviceMotionAvailable else {
            phase = .unavailable
            return
        }
        reset()
        phase = .settling
        motion.deviceMotionUpdateInterval = 1.0 / Self.updateHz
        motion.startDeviceMotionUpdates(
            using: .xMagneticNorthZVertical,
            to: queue
        ) { [weak self] deviceMotion, _ in
            guard let deviceMotion else { return }
            // CoreMotion delivers on `queue`; hop to the main actor for state.
            let sample = Self.sample(from: deviceMotion)
            let headingAccuracy = deviceMotion.heading >= 0
                ? Self.headingAccuracy(deviceMotion)
                : nil
            Task { @MainActor [weak self] in
                self?.ingest(sample, headingAccuracyDeg: headingAccuracy)
            }
        }
    }

    /// Stop updates and return to idle without producing a reading.
    func cancel() {
        motion.stopDeviceMotionUpdates()
        reset()
        phase = .idle
    }

    /// Reset back to a clean state for another reading (keeps `phase`).
    private func reset() {
        recent.removeAll(keepingCapacity: true)
        window.removeAll(keepingCapacity: true)
        windowStart = nil
        isSettled = false
        reading = nil
        verdict = nil
        liveTiltDeg = 0
        liveSlopePct = 0
        liveFallLineDeg = 0
        headingAccuracyDeg = nil
    }

    // MARK: - Sample ingest (main actor)

    private func ingest(_ sample: SpotLevelMath.Sample, headingAccuracyDeg: Double?) {
        guard phase == .settling || phase == .capturing else { return }

        self.headingAccuracyDeg = headingAccuracyDeg
        liveTiltDeg = SpotLevelMath.tiltDegrees(gx: sample.gx, gy: sample.gy, gz: sample.gz)
        liveSlopePct = SpotLevelMath.slopeFractionFromGravity(
            gx: sample.gx, gy: sample.gy, gz: sample.gz
        ) * 100
        liveFallLineDeg = SpotLevelMath.fallLineBearingDegrees(
            gx: sample.gx, gy: sample.gy, headingDeg: sample.headingDeg
        )

        // Maintain the bounded settle-gate ring.
        recent.append(sample)
        if recent.count > Self.settleGateSampleCount {
            recent.removeFirst(recent.count - Self.settleGateSampleCount)
        }

        switch phase {
        case .settling:
            if settleGatePassed() {
                isSettled = true
                phase = .capturing
                window.removeAll(keepingCapacity: true)
                windowStart = CACurrentMediaTime()
                window.append(sample)
            }
        case .capturing:
            window.append(sample)
            let elapsed = CACurrentMediaTime() - (windowStart ?? CACurrentMediaTime())
            if elapsed >= Self.windowDurationS {
                finish(durationS: elapsed)
            }
        default:
            break
        }
    }

    /// The settle gate: enough recent samples, all holding a stable tilt
    /// (std-dev under the yellow threshold — capturing on jitter is pointless).
    private func settleGatePassed() -> Bool {
        guard recent.count >= Self.settleGateSampleCount else { return false }
        let reduced = SpotLevelMath.reduce(recent, durationS: 0)
        return reduced.tiltStdDeg <= Self.yellowTiltStdDeg
    }

    /// Reduce the captured window, assign a verdict, stop updates.
    private func finish(durationS: Double) {
        motion.stopDeviceMotionUpdates()
        let reduced = SpotLevelMath.reduce(window, durationS: durationS)
        reading = reduced
        verdict = Self.verdict(
            tiltStdDeg: reduced.tiltStdDeg,
            headingAccuracyDeg: headingAccuracyDeg
        )
        phase = .done
    }

    // MARK: - Pure helpers

    /// Derive the verdict from settling + compass health (doc §4.2). A window
    /// that reduced fine but with an unusable compass is red — the fall line is
    /// the point of a spot level.
    nonisolated static func verdict(tiltStdDeg: Double, headingAccuracyDeg: Double?) -> GreenScanVerdict {
        if let acc = headingAccuracyDeg, acc > maxHeadingAccuracyDeg {
            return .red
        }
        if headingAccuracyDeg == nil {
            // Compass never reported a usable accuracy → refuse.
            return .red
        }
        if tiltStdDeg <= greenTiltStdDeg { return .green }
        if tiltStdDeg <= yellowTiltStdDeg { return .yellow }
        return .red
    }

    /// Map a `CMDeviceMotion` to the pure sample. `gravity` is already a
    /// device-frame unit vector toward earth; `heading` is the compass bearing
    /// of the reference frame's forward axis (degrees, or negative if unknown).
    private static func sample(from dm: CMDeviceMotion) -> SpotLevelMath.Sample {
        let g = dm.gravity
        // CoreMotion `heading` is the rotation of the device about the vertical
        // relative to the reference frame's north — the compass bearing of the
        // device's forward (top edge) direction. Clamp unknown (-1) to 0; the
        // accuracy field flags it as unusable and the verdict rejects it.
        let heading = dm.heading >= 0 ? dm.heading : 0
        return SpotLevelMath.Sample(gx: g.x, gy: g.y, gz: g.z, headingDeg: heading)
    }

    /// CoreMotion does not expose a heading-accuracy on `CMDeviceMotion`; the
    /// magnetometer calibration accuracy is the proxy. We approximate it from
    /// the magnetic-field calibration accuracy, mapping the enum to a degree
    /// band. `.high` ≈ 5°, `.medium` ≈ 20°, `.low` ≈ 35°, uncalibrated → large.
    private static func headingAccuracy(_ dm: CMDeviceMotion) -> Double {
        switch dm.magneticField.accuracy {
        case .high: return 5
        case .medium: return 20
        case .low: return 35
        case .uncalibrated: return 180
        @unknown default: return 180
        }
    }
}
