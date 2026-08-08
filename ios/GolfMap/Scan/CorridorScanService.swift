import CoreMotion
import Foundation
import Observation
#if canImport(ARKit)
import ARKit
#endif

/// Thin ARKit wrapper driving the out-and-back LiDAR corridor scan (task E1,
/// doc §4.1). ALL geometry/QC lives in `CorridorFitMath` (pure, fully
/// tested); this layer adapts the sensors:
///
///  - `ARWorldTrackingConfiguration` with `.gravity` world alignment +
///    `sceneDepth`: the world frame's vertical is gravity-anchored, so
///    roll/pitch (what slope needs) is trustworthy while yaw/position drift
///    is not — the whole design leans on that (doc §2 insight 2).
///  - Per processed frame, high-confidence depth pixels are subsampled,
///    unprojected into the gravity world, pre-filtered to a ground band
///    below the camera, and buffered per pass. The corridor band around the
///    ball→hole line is applied AFTER the hole is marked (the line isn't
///    known until then) in `CorridorFitMath.prepareCorridor`.
///  - The two static endpoint levels reuse the D2 `SpotLevelCapture`
///    unchanged (phone laid flat at ball and hole — the free drift check).
///  - The payload's `frame.originalLineBearingDeg` is snapshotted at
///    hole-marking: CoreMotion compass heading paired with the camera's
///    horizontal look direction calibrates the (drifty, arbitrary-heading)
///    AR world to compass north; the ball→hole world direction then maps to
///    a bearing. Weak metadata by design — the read itself never uses it
///    (`ScannedSurface` anchors to the user-placed markers instead).
///
/// **Hardware gate:** `isSupported` requires sceneDepth (LiDAR). Everything
/// compiles for the simulator; `start()` lands in `.unavailable` there.
///
/// **State machine** (one guided walk):
/// idle → anchorBall → levelBall → readyToWalkOut → walkOut → levelHole →
/// readyToWalkBack → walkBack → fitting → done | failed. The sheet drives
/// the taps; ingestion only runs in the two walk phases.
@MainActor
@Observable
final class CorridorScanService {

    // MARK: - Tunables (sensor-boundary; the QC constants live in CorridorFitMath)

    /// Process every Nth AR frame (60 Hz feed → ~10 Hz ingest).
    nonisolated static let frameStride = 6
    /// Depth-map pixel subsampling stride (256×192 map → ~768 candidates).
    nonisolated static let pixelStride = 8
    /// Depth range kept: nearer is the user's own body/phone shadow, farther
    /// is grazing-angle noise (ARKit depth error ~1% of range; the useful
    /// footprint from ~1 m hold height is a 2–3 m radius patch, doc §4.1).
    nonisolated static let minDepthM = 0.3
    nonisolated static let maxDepthM = 4.0
    /// Ground pre-filter: keep points this far BELOW the camera (in hand,
    /// roughly 0.5–2 m above the green). Final surface banding happens after
    /// ground anchoring in `prepareCorridor`.
    nonisolated static let groundBelowCameraMinM = 0.4
    nonisolated static let groundBelowCameraMaxM = 2.2
    /// Raw per-pass point budget (memory guard; a 10 m walk at ~10 Hz with a
    /// few hundred retained points per frame sits well under this).
    nonisolated static let maxPointsPerPass = 160_000
    /// Minimum usable line length / per-pass corridor points for a fit.
    nonisolated static let minLineLengthM = 2.0
    nonisolated static let minPassPoints = 500

    // MARK: - Crosshair aiming

    /// Half-size (depth-map pixels) of the patch sampled under the crosshair.
    /// ±3 on a 256×192 map ≈ a 5 cm spot at 1.5 m — the ball, not the fairway
    /// behind it.
    nonisolated static let aimPatchHalfPixels = 3
    /// Valid pixels the patch needs before the aim point is trusted.
    nonisolated static let minAimPatchPixels = 8
    /// Aiming reaches further than the fit cloud does: pointing at the ball
    /// from standing height is ~1.5 m, marking the hole from a step away up to
    /// ~5 m. Depth accuracy at that range (~1%) is centimeters — fine for an
    /// endpoint, unusable for surface slope, hence the separate limit.
    nonisolated static let maxAimDepthM = 5.0

    // MARK: - Phase

    enum Phase: Equatable {
        /// Not running.
        case idle
        /// No LiDAR/sceneDepth on this device (or simulator).
        case unavailable
        /// Session running; hold the phone over the ball, tap "Anchor ball".
        case anchorBall
        /// Static IMU level at the ball (spot-level capture running).
        case levelBall
        /// Ball level done — pick the phone up, tap to start walking.
        case readyToWalkOut
        /// Walking ball → hole, collecting the out pass. Tap "Mark hole".
        case walkOut
        /// Static IMU level at the hole.
        case levelHole
        /// Hole level done — tap to start the return walk.
        case readyToWalkBack
        /// Walking hole → ball, collecting the back pass. Tap "Finish".
        case walkBack
        /// Fits + QC running off-main.
        case fitting
        /// `result` is populated.
        case done
        /// Scan unusable (message for the user); re-scan to try again.
        case failed(String)
    }

    private(set) var phase: Phase = .idle

    // MARK: - Live progress (observable)

    /// Raw points buffered so far (both passes) — the live coverage hint.
    private(set) var pointCount = 0
    /// Horizontal camera distance from the ball anchor, meters.
    private(set) var distanceFromBallM: Double = 0
    /// Range to the point under the crosshair, meters — nil when the centre
    /// of the frame has no usable depth (too far, too dark, no surface). The
    /// crosshair renders live off this, and marking is gated on it.
    private(set) var aimDistanceM: Double?

    // MARK: - Endpoint levels (reused D2 capture, owned here)

    /// The spot-level capture the sheet renders during the two level phases.
    let level = SpotLevelCapture()

    private(set) var ballLevel: SpotLevelMath.Reading?
    private(set) var ballLevelHeadingAccuracyDeg: Double?
    private(set) var holeLevel: SpotLevelMath.Reading?
    private(set) var holeLevelHeadingAccuracyDeg: Double?

    // MARK: - Result

    /// Everything the verdict screen / payload assembly needs. Produced by
    /// the pure `fitScan` below.
    struct ScanComputation: Sendable, Equatable {
        var lineLengthM: Double
        var combined: CorridorFitMath.Poly2Fit
        var outFit: CorridorFitMath.Poly2Fit
        var backFit: CorridorFitMath.Poly2Fit
        var combinedCoverageFrac: Double
        var outCoverageFrac: Double
        var backCoverageFrac: Double
        var passMismatchSlopePct: Double
        /// nil when either endpoint level was skipped.
        var endpointLevelDeltaPct: Double?
        var verdict: GreenScanVerdict
        /// Decimated (≤ 5000) scan-frame points for the payload, mm-rounded.
        var payloadPoints: [[Double]]
        /// Retained-point bounds (scan frame) — `ScannedSurface`'s coverage.
        var xMin: Double
        var xMax: Double
        var yMin: Double
        var yMax: Double
    }

    private(set) var result: ScanComputation?
    /// Compass bearing of the ball→hole line snapshotted at hole-marking,
    /// nil when the compass was unusable (payload falls back to the
    /// marker-derived bearing).
    private(set) var lineBearingDeg: Double?

    // MARK: - Internals

    /// One processed AR frame from the sensor layer (ARKit gravity world,
    /// +y up).
    struct FrameSample: Sendable {
        var points: [CorridorFitMath.P3]
        var cameraPos: CorridorFitMath.P3
        /// Horizontal projection of the camera look direction (x/z, world).
        var lookX: Double
        var lookZ: Double
        /// World point under the screen-centre crosshair (median of a small
        /// high-confidence depth patch), nil when the centre has no usable
        /// depth. THE anchor for ball/hole marking — aiming at the ball beats
        /// holding the phone over it (see `anchorBall`).
        var centerHitWorld: CorridorFitMath.P3?
        /// Range to that point, meters — the aim readout / in-range gate.
        var centerHitDistanceM: Double?
    }

    @ObservationIgnored private var outWorld: [CorridorFitMath.P3] = []
    @ObservationIgnored private var backWorld: [CorridorFitMath.P3] = []
    @ObservationIgnored private var ballAnchor: CorridorFitMath.P3?
    @ObservationIgnored private var holeAnchor: CorridorFitMath.P3?
    @ObservationIgnored private var latestCameraPos: CorridorFitMath.P3?
    @ObservationIgnored private var latestCenterHit: CorridorFitMath.P3?
    @ObservationIgnored private var latestLook: (x: Double, z: Double)?
    @ObservationIgnored private var latestHeadingDeg: Double?

    /// Heading stream for the bearing snapshot (walk phases only, so it
    /// never overlaps the level capture's own CMMotionManager).
    @ObservationIgnored private let headingMotion = CMMotionManager()
    @ObservationIgnored private let headingQueue = OperationQueue()

    #if canImport(ARKit)
    @ObservationIgnored private var session: ARSession?
    @ObservationIgnored private var sessionDelegate: ScanSessionDelegate?

    /// The running session, for the camera preview to render. Observable on
    /// purpose (unlike the rest of the AR internals): the preview has to
    /// re-attach when `start()` builds a new session.
    var previewSession: ARSession? { session }

    /// Re-assert our frame delegate. `ARSCNView.session = …` may install
    /// itself as the session's delegate; losing ours would silently stop all
    /// point collection, so the preview calls this right after attaching.
    func reassertSessionDelegate() {
        guard let session, let sessionDelegate else { return }
        if session.delegate !== sessionDelegate {
            session.delegate = sessionDelegate
        }
    }
    #endif

    init() {
        headingQueue.maxConcurrentOperationCount = 1
        headingQueue.name = "CorridorScanHeading"
    }

    /// LiDAR/sceneDepth availability — the only devices offered scanning.
    nonisolated static var isSupported: Bool {
        #if canImport(ARKit)
        return ARWorldTrackingConfiguration.isSupported
            && ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
        #else
        return false
        #endif
    }

    // MARK: - Control (the sheet drives these)

    /// Start the AR session and enter the guided flow.
    func start() {
        guard phase == .idle || phase == .done, Self.isSupported else {
            if !Self.isSupported { phase = .unavailable }
            return
        }
        reset()
        #if canImport(ARKit)
        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        configuration.frameSemantics =
            ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
            ? .smoothedSceneDepth
            : .sceneDepth
        let delegate = ScanSessionDelegate { [weak self] sample in
            Task { @MainActor [weak self] in
                self?.ingest(sample)
            }
        }
        let newSession = ARSession()
        newSession.delegateQueue = DispatchQueue(label: "CorridorScanSession")
        newSession.delegate = delegate
        newSession.run(configuration)
        session = newSession
        sessionDelegate = delegate
        phase = .anchorBall
        #else
        phase = .unavailable
        #endif
    }

    /// Tear everything down (sheet dismissed / cancel).
    func cancel() {
        #if canImport(ARKit)
        session?.pause()
        session = nil
        sessionDelegate = nil
        #endif
        level.cancel()
        stopHeadingUpdates()
        reset()
        phase = .idle
    }

    /// Tap "Anchor ball" with the crosshair on the ball: records the world
    /// point under the crosshair as the ball anchor, then runs the static
    /// level.
    ///
    /// The crosshair hit is the accurate anchor — it is the actual point on
    /// the green being aimed at. `latestCameraPos` (the phone's own position,
    /// ~1 m up and wherever the hand is) is only the fallback for the frame
    /// where depth is missing. Anchor HEIGHT is irrelevant either way:
    /// `prepareCorridor` re-levels z from the near-ball ground points; only
    /// the horizontal x/z matter, which is exactly what the crosshair fixes.
    func anchorBall() {
        guard phase == .anchorBall, let anchor = latestCenterHit ?? latestCameraPos else { return }
        ballAnchor = anchor
        phase = .levelBall
        level.start()
    }

    /// Skip the static level at this endpoint. The endpoint levels are a
    /// quality *cross-check* (`endpointLevelDeltaPct`), not an input to the
    /// read or its verdict — so a player who does not want to put the phone
    /// down can walk straight on. The uploaded payload then carries no
    /// endpoint levels and the delta is omitted.
    func skipLevel() {
        switch phase {
        case .levelBall:
            level.cancel()
            phase = .readyToWalkOut
        case .levelHole:
            level.cancel()
            phase = .readyToWalkBack
        default:
            return
        }
    }

    /// Level settled at the ball (sheet gates on `level.phase == .done` and
    /// a non-red verdict) — store it, wait for pickup.
    func confirmBallLevel() {
        guard phase == .levelBall, let reading = level.reading,
              level.verdict != nil, level.verdict != .red
        else { return }
        ballLevel = reading
        ballLevelHeadingAccuracyDeg = level.headingAccuracyDeg
        phase = .readyToWalkOut
    }

    /// Phone picked back up — start collecting the out pass.
    func beginWalkOut() {
        guard phase == .readyToWalkOut else { return }
        startHeadingUpdates()
        phase = .walkOut
    }

    /// Tap "Mark hole" while holding the phone over the hole: records the
    /// hole anchor + the compass/look bearing snapshot, then runs the second
    /// static level.
    func markHole() {
        guard phase == .walkOut, let anchor = latestCenterHit ?? latestCameraPos,
              let ball = ballAnchor
        else { return }
        holeAnchor = anchor
        // Bearing snapshot: compass heading of the look direction now, the
        // ball→hole world direction rotated into compass frame.
        if let heading = latestHeadingDeg, let look = latestLook {
            lineBearingDeg = CorridorFitMath.bearingDeg(
                ofX: anchor.x - ball.x, z: anchor.z - ball.z,
                referenceX: look.x, referenceZ: look.z,
                referenceBearingDeg: heading
            )
        }
        stopHeadingUpdates()
        phase = .levelHole
        level.start()
    }

    /// Level settled at the hole — store it, wait for pickup.
    func confirmHoleLevel() {
        guard phase == .levelHole, let reading = level.reading,
              level.verdict != nil, level.verdict != .red
        else { return }
        holeLevel = reading
        holeLevelHeadingAccuracyDeg = level.headingAccuracyDeg
        phase = .readyToWalkBack
    }

    /// Start collecting the back pass.
    func beginWalkBack() {
        guard phase == .readyToWalkBack else { return }
        phase = .walkBack
    }

    /// Back at the ball — run fits + QC off the main actor.
    func finish() {
        guard phase == .walkBack, let ball = ballAnchor, let hole = holeAnchor
        else { return }
        phase = .fitting
        #if canImport(ARKit)
        session?.pause()
        #endif
        let out = outWorld
        let back = backWorld
        // nil when the level was skipped — the endpoint cross-check is then
        // omitted rather than faked.
        let ballSlopePct = ballLevel?.slopePct
        let holeSlopePct = holeLevel?.slopePct
        Task.detached(priority: .userInitiated) { [weak self] in
            let outcome = CorridorScanService.fitScan(
                outWorld: out, backWorld: back,
                ballAnchorWorld: ball, holeAnchorWorld: hole,
                ballLevelSlopePct: ballSlopePct, holeLevelSlopePct: holeSlopePct
            )
            await MainActor.run { [weak self] in
                guard let self, self.phase == .fitting else { return }
                switch outcome {
                case .success(let computation):
                    self.result = computation
                    self.phase = .done
                case .failure(let message):
                    self.phase = .failed(message)
                }
            }
        }
    }

    /// Restart a level capture that came back red.
    func retryLevel() {
        guard phase == .levelBall || phase == .levelHole else { return }
        level.start()
    }

    // MARK: - Pure fit pipeline (simulator-testable; no sensor types)

    enum FitOutcome: Sendable, Equatable {
        case success(ScanComputation)
        case failure(String)
    }

    /// The whole below-the-sensor pipeline: world clouds → scan frame →
    /// corridor filter/ground anchor → per-pass + combined robust poly2 fits
    /// → coverage / mismatch / endpoint QC → verdict → decimated payload
    /// points. Pure and deterministic — tested with synthetic clouds.
    nonisolated static func fitScan(
        outWorld: [CorridorFitMath.P3],
        backWorld: [CorridorFitMath.P3],
        ballAnchorWorld: CorridorFitMath.P3,
        holeAnchorWorld: CorridorFitMath.P3,
        ballLevelSlopePct: Double?,
        holeLevelSlopePct: Double?
    ) -> FitOutcome {
        guard let clouds = CorridorFitMath.prepareCorridor(
            outWorld: outWorld, backWorld: backWorld,
            ballAnchorWorld: ballAnchorWorld, holeAnchorWorld: holeAnchorWorld
        ) else {
            return .failure("Couldn't anchor the scan to the green surface — re-scan, keeping the phone pointed at the grass.")
        }
        guard clouds.lineLengthM >= minLineLengthM else {
            return .failure("The walk was too short to fit a corridor — anchor at the ball, then mark the hole from the hole.")
        }
        guard clouds.out.count >= minPassPoints, clouds.back.count >= minPassPoints else {
            return .failure("Not enough surface points along the line — walk slower with the phone facing the green.")
        }
        guard
            let outFit = CorridorFitMath.fitPoly2Robust(clouds.out),
            let backFit = CorridorFitMath.fitPoly2Robust(clouds.back),
            let combined = CorridorFitMath.fitPoly2Robust(clouds.out + clouds.back)
        else {
            return .failure("The surface fit failed — re-scan the corridor.")
        }

        let mismatch = CorridorFitMath.passMismatchSlopePct(
            out: outFit, back: backFit, lineLengthM: clouds.lineLengthM
        )
        let coverage = CorridorFitMath.coverageFrac(
            clouds.out + clouds.back, lineLengthM: clouds.lineLengthM
        )
        // Only computable when both endpoint levels were taken.
        let endpointDelta: Double? =
            if let ballLevelSlopePct, let holeLevelSlopePct {
                CorridorFitMath.endpointLevelDeltaPct(
                    fit: combined, lineLengthM: clouds.lineLengthM,
                    ballLevelSlopePct: ballLevelSlopePct, holeLevelSlopePct: holeLevelSlopePct
                )
            } else {
                nil
            }
        let verdict = CorridorFitMath.verdict(
            passMismatchSlopePct: mismatch,
            rmseM: combined.rmseM,
            coverageFrac: coverage
        )

        // Payload points: decimate the combined cloud, round to mm (the
        // contract keeps points so the server can refit with better math;
        // sub-mm digits are noise and JSON weight).
        let payloadPoints = CorridorFitMath.decimate(clouds.out + clouds.back).map { p in
            [(p.x * 1000).rounded() / 1000,
             (p.y * 1000).rounded() / 1000,
             (p.z * 1000).rounded() / 1000]
        }

        return .success(ScanComputation(
            lineLengthM: clouds.lineLengthM,
            combined: combined,
            outFit: outFit,
            backFit: backFit,
            combinedCoverageFrac: coverage,
            outCoverageFrac: CorridorFitMath.coverageFrac(clouds.out, lineLengthM: clouds.lineLengthM),
            backCoverageFrac: CorridorFitMath.coverageFrac(clouds.back, lineLengthM: clouds.lineLengthM),
            passMismatchSlopePct: mismatch,
            endpointLevelDeltaPct: endpointDelta,
            verdict: verdict,
            payloadPoints: payloadPoints,
            xMin: clouds.xMin, xMax: clouds.xMax,
            yMin: clouds.yMin, yMax: clouds.yMax
        ))
    }

    // MARK: - Ingest (main actor)

    private func ingest(_ sample: FrameSample) {
        latestCameraPos = sample.cameraPos
        latestCenterHit = sample.centerHitWorld
        aimDistanceM = sample.centerHitDistanceM
        latestLook = (sample.lookX, sample.lookZ)
        if let ball = ballAnchor {
            let dx = sample.cameraPos.x - ball.x
            let dz = sample.cameraPos.z - ball.z
            distanceFromBallM = (dx * dx + dz * dz).squareRoot()
        }
        switch phase {
        case .walkOut:
            if outWorld.count < Self.maxPointsPerPass {
                outWorld.append(contentsOf: sample.points)
            }
        case .walkBack:
            if backWorld.count < Self.maxPointsPerPass {
                backWorld.append(contentsOf: sample.points)
            }
        default:
            return
        }
        pointCount = outWorld.count + backWorld.count
    }

    private func reset() {
        outWorld.removeAll()
        backWorld.removeAll()
        ballAnchor = nil
        holeAnchor = nil
        latestCameraPos = nil
        latestCenterHit = nil
        aimDistanceM = nil
        latestLook = nil
        latestHeadingDeg = nil
        ballLevel = nil
        ballLevelHeadingAccuracyDeg = nil
        holeLevel = nil
        holeLevelHeadingAccuracyDeg = nil
        result = nil
        lineBearingDeg = nil
        pointCount = 0
        distanceFromBallM = 0
    }

    // MARK: - Heading stream (bearing metadata only)

    private func startHeadingUpdates() {
        guard headingMotion.isDeviceMotionAvailable else { return }
        headingMotion.deviceMotionUpdateInterval = 0.1
        // Explicitly `@Sendable` — see `SpotLevelCapture.start()`: a plain
        // closure here inherits `@MainActor` and traps when CoreMotion calls it
        // on `headingQueue`.
        let handler: @Sendable (CMDeviceMotion?, Error?) -> Void = { [weak self] deviceMotion, _ in
            guard let deviceMotion, deviceMotion.heading >= 0 else { return }
            let heading = deviceMotion.heading
            Task { @MainActor [weak self] in
                self?.latestHeadingDeg = heading
            }
        }
        headingMotion.startDeviceMotionUpdates(
            using: .xMagneticNorthZVertical,
            to: headingQueue,
            withHandler: handler
        )
    }

    private func stopHeadingUpdates() {
        headingMotion.stopDeviceMotionUpdates()
    }
}

// MARK: - ARSession delegate (sensor boundary)

#if canImport(ARKit)
/// Nonisolated ARSession delegate: extracts a `FrameSample` from every Nth
/// frame ON the session's serial delegate queue (ARFrame must not leave the
/// callback — only plain value types are forwarded) and hops the result to
/// the main actor via the callback.
private final class ScanSessionDelegate: NSObject, ARSessionDelegate, Sendable {

    private let onSample: @Sendable (CorridorScanService.FrameSample) -> Void
    /// Frame decimation counter. ARSession delivers delegate callbacks
    /// serially on the one delegate queue, so unsynchronized mutation is
    /// safe by construction.
    nonisolated(unsafe) private var frameIndex = 0

    init(onSample: @escaping @Sendable (CorridorScanService.FrameSample) -> Void) {
        self.onSample = onSample
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        frameIndex += 1
        guard frameIndex % CorridorScanService.frameStride == 0 else { return }

        let camera = frame.camera
        let transform = camera.transform
        let cameraPos = CorridorFitMath.P3(
            x: Double(transform.columns.3.x),
            y: Double(transform.columns.3.y),
            z: Double(transform.columns.3.z)
        )
        // The camera looks along its −z axis.
        let lookX = Double(-transform.columns.2.x)
        let lookZ = Double(-transform.columns.2.z)

        var points: [CorridorFitMath.P3] = []
        var centerHit: CorridorFitMath.P3?
        var centerRange: Double?
        // Depth is only useful while tracking is normal — a relocalizing
        // pose would smear points across the world.
        if case .normal = camera.trackingState,
           let depthData = frame.smoothedSceneDepth ?? frame.sceneDepth {
            points = Self.extractGroundPoints(
                depthData: depthData,
                camera: camera,
                transform: transform,
                cameraY: cameraPos.y
            )
            if let hit = Self.centerHit(
                depthData: depthData, camera: camera, transform: transform
            ) {
                centerHit = hit.world
                centerRange = hit.rangeM
            }
        }

        onSample(CorridorScanService.FrameSample(
            points: points, cameraPos: cameraPos, lookX: lookX, lookZ: lookZ,
            centerHitWorld: centerHit, centerHitDistanceM: centerRange
        ))
    }

    /// The world point under the screen-centre crosshair: median depth over a
    /// small high-confidence patch at the centre of the depth map, unprojected
    /// and transformed to the gravity world.
    ///
    /// The depth map centre IS the screen centre — the preview renders the
    /// camera image aspect-fill, which crops the edges symmetrically and
    /// leaves the centre fixed. A patch median (not a single pixel) because a
    /// lone depth pixel on grass is noisy and occasionally invalid.
    private static func centerHit(
        depthData: ARDepthData,
        camera: ARCamera,
        transform: simd_float4x4
    ) -> (world: CorridorFitMath.P3, rangeM: Double)? {
        let depthMap = depthData.depthMap
        guard let confidenceMap = depthData.confidenceMap else { return nil }
        guard CVPixelBufferGetPixelFormatType(depthMap) == kCVPixelFormatType_DepthFloat32,
              CVPixelBufferGetPixelFormatType(confidenceMap) == kCVPixelFormatType_OneComponent8
        else { return nil }

        CVPixelBufferLockBaseAddress(depthMap, .readOnly)
        CVPixelBufferLockBaseAddress(confidenceMap, .readOnly)
        defer {
            CVPixelBufferUnlockBaseAddress(depthMap, .readOnly)
            CVPixelBufferUnlockBaseAddress(confidenceMap, .readOnly)
        }
        guard let depthBase = CVPixelBufferGetBaseAddress(depthMap),
              let confidenceBase = CVPixelBufferGetBaseAddress(confidenceMap)
        else { return nil }

        let width = CVPixelBufferGetWidth(depthMap)
        let height = CVPixelBufferGetHeight(depthMap)
        let depthStride = CVPixelBufferGetBytesPerRow(depthMap) / MemoryLayout<Float32>.stride
        let confidenceStride = CVPixelBufferGetBytesPerRow(confidenceMap)
        let depthPixels = depthBase.assumingMemoryBound(to: Float32.self)
        let confidencePixels = confidenceBase.assumingMemoryBound(to: UInt8.self)

        let centerU = width / 2
        let centerV = height / 2
        let half = CorridorScanService.aimPatchHalfPixels
        // `.medium` and up: the crosshair must still find the surface at a
        // grazing angle, where the strict `.high` gate used for the fit cloud
        // thins out.
        let minConfidence = UInt8(ARConfidenceLevel.medium.rawValue)

        var depths: [Double] = []
        depths.reserveCapacity((2 * half + 1) * (2 * half + 1))
        for v in (centerV - half)...(centerV + half) {
            guard v >= 0, v < height else { continue }
            for u in (centerU - half)...(centerU + half) {
                guard u >= 0, u < width else { continue }
                guard confidencePixels[v * confidenceStride + u] >= minConfidence else { continue }
                let depth = Double(depthPixels[v * depthStride + u])
                guard depth.isFinite,
                      depth >= CorridorScanService.minDepthM,
                      depth <= CorridorScanService.maxAimDepthM
                else { continue }
                depths.append(depth)
            }
        }
        guard depths.count >= CorridorScanService.minAimPatchPixels else { return nil }
        depths.sort()
        let range = depths[depths.count / 2]

        let intrinsics = camera.intrinsics
        let scaleX = Double(width) / Double(camera.imageResolution.width)
        let scaleY = Double(height) / Double(camera.imageResolution.height)
        let fx = Double(intrinsics.columns.0.x) * scaleX
        let fy = Double(intrinsics.columns.1.y) * scaleY
        let cx = Double(intrinsics.columns.2.x) * scaleX
        let cy = Double(intrinsics.columns.2.y) * scaleY
        guard fx > 0, fy > 0 else { return nil }

        let local = CorridorFitMath.unprojectDepthPixel(
            u: Double(centerU), v: Double(centerV), depthM: range,
            fx: fx, fy: fy, cx: cx, cy: cy
        )
        let world = transform * simd_float4(Float(local.x), Float(local.y), Float(local.z), 1)
        return (
            CorridorFitMath.P3(x: Double(world.x), y: Double(world.y), z: Double(world.z)),
            range
        )
    }

    /// Subsample the depth map, keep high-confidence pixels in range,
    /// unproject to the gravity world, and pre-filter to the ground band
    /// below the camera. Pure CVPixelBuffer reads — runs on the delegate
    /// queue.
    private static func extractGroundPoints(
        depthData: ARDepthData,
        camera: ARCamera,
        transform: simd_float4x4,
        cameraY: Double
    ) -> [CorridorFitMath.P3] {
        let depthMap = depthData.depthMap
        guard let confidenceMap = depthData.confidenceMap else { return [] }
        guard CVPixelBufferGetPixelFormatType(depthMap) == kCVPixelFormatType_DepthFloat32,
              CVPixelBufferGetPixelFormatType(confidenceMap) == kCVPixelFormatType_OneComponent8
        else { return [] }

        CVPixelBufferLockBaseAddress(depthMap, .readOnly)
        CVPixelBufferLockBaseAddress(confidenceMap, .readOnly)
        defer {
            CVPixelBufferUnlockBaseAddress(depthMap, .readOnly)
            CVPixelBufferUnlockBaseAddress(confidenceMap, .readOnly)
        }
        guard let depthBase = CVPixelBufferGetBaseAddress(depthMap),
              let confidenceBase = CVPixelBufferGetBaseAddress(confidenceMap)
        else { return [] }

        let width = CVPixelBufferGetWidth(depthMap)
        let height = CVPixelBufferGetHeight(depthMap)
        let depthStride = CVPixelBufferGetBytesPerRow(depthMap) / MemoryLayout<Float32>.stride
        let confidenceStride = CVPixelBufferGetBytesPerRow(confidenceMap)
        let depthPixels = depthBase.assumingMemoryBound(to: Float32.self)
        let confidencePixels = confidenceBase.assumingMemoryBound(to: UInt8.self)

        // Intrinsics are for the full camera image — scale to the depth map.
        let intrinsics = camera.intrinsics
        let scaleX = Double(width) / Double(camera.imageResolution.width)
        let scaleY = Double(height) / Double(camera.imageResolution.height)
        let fx = Double(intrinsics.columns.0.x) * scaleX
        let fy = Double(intrinsics.columns.1.y) * scaleY
        let cx = Double(intrinsics.columns.2.x) * scaleX
        let cy = Double(intrinsics.columns.2.y) * scaleY
        guard fx > 0, fy > 0 else { return [] }

        let high = UInt8(ARConfidenceLevel.high.rawValue)
        var points: [CorridorFitMath.P3] = []
        points.reserveCapacity((width / CorridorScanService.pixelStride)
            * (height / CorridorScanService.pixelStride))

        var v = CorridorScanService.pixelStride / 2
        while v < height {
            var u = CorridorScanService.pixelStride / 2
            while u < width {
                let confidence = confidencePixels[v * confidenceStride + u]
                if confidence >= high {
                    let depth = Double(depthPixels[v * depthStride + u])
                    if depth >= CorridorScanService.minDepthM,
                       depth <= CorridorScanService.maxDepthM,
                       depth.isFinite {
                        let local = CorridorFitMath.unprojectDepthPixel(
                            u: Double(u), v: Double(v), depthM: depth,
                            fx: fx, fy: fy, cx: cx, cy: cy
                        )
                        let world = transform * simd_float4(
                            Float(local.x), Float(local.y), Float(local.z), 1
                        )
                        let worldY = Double(world.y)
                        // Ground band below the camera.
                        if worldY <= cameraY - CorridorScanService.groundBelowCameraMinM,
                           worldY >= cameraY - CorridorScanService.groundBelowCameraMaxM {
                            points.append(CorridorFitMath.P3(
                                x: Double(world.x), y: worldY, z: Double(world.z)
                            ))
                        }
                    }
                }
                u += CorridorScanService.pixelStride
            }
            v += CorridorScanService.pixelStride
        }
        return points
    }
}
#endif
