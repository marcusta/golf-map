import CoreLocation
import CoreMotion
import Foundation
import Observation
import os

/// Sensors and shutter for a reference photo (docs/feature-reference-photos.md
/// §4.2). Runs the camera (`CameraController`), device motion at
/// `motionHz` in `.xTrueNorthZVertical` (falls back to
/// `.xMagneticNorthZVertical` and records it), and a location manager for the
/// fix and the heading accuracy. All geometry lives in `CameraPoseMath`.
///
/// At the shutter it takes the median attitude of the last `shutterWindowS`
/// seconds, checks the rotation rate against `maxRotationRateRadS`, captures
/// the HEIC, writes original, preview and thumbnail, reads the image up axis
/// back from the file's EXIF orientation, and stores a `pending` row. The
/// network is never involved; `PhotoSyncService` uploads later.
@MainActor
@Observable
final class PhotoCaptureService {

    // MARK: - Tunables

    nonisolated static let motionHz = 60.0
    /// Samples averaged at the shutter (doc §4.2).
    nonisolated static let shutterWindowS = 0.3
    /// Rotation-rate magnitude (rad/s) at or under which the phone counts as
    /// still over the shutter window. 0.1 rad/s is 5.7°/s; to be tuned in the
    /// field test.
    nonisolated static let maxRotationRateRadS = 0.1
    /// GPS horizontal accuracy (m) above which the chip turns amber.
    nonisolated static let gpsAmberAboveM = 5.0
    /// `CLHeading.headingAccuracy` (deg) above which the chip turns amber.
    nonisolated static let headingAmberAboveDeg = 10.0
    /// Motion samples kept (1 s at `motionHz`).
    nonisolated static let sampleBufferCount = 60

    private static let log = Logger(subsystem: "golfmap", category: "reference-photo")

    // MARK: - Observable state

    enum CameraState: Equatable {
        case starting
        case ready
        case denied
        case unavailable(String)
    }

    private(set) var cameraState: CameraState = .starting
    /// `videoFieldOfView` of the active format, nil until the camera is ready.
    private(set) var longSideFovDeg: Double?
    private(set) var motionAvailable = true
    /// False when CoreMotion runs in the magnetic-north frame.
    private(set) var usingTrueNorth = true
    private(set) var location: CLLocation?
    private(set) var headingAccuracyDeg: Double?
    /// true − magnetic heading from the last valid `CLHeading`.
    private(set) var declinationDeg: Double?
    private(set) var magCalibration: Int?
    /// Live gravity in the device frame (unit g).
    private(set) var gravity: CameraPoseMath.Vec3?
    /// Live camera pose in the current hold's frame.
    private(set) var livePose: CameraPoseMath.Pose?
    /// Live pose in the portrait (screen) frame, for the horizon line.
    private(set) var screenPose: CameraPoseMath.Pose?
    /// How the phone is held; updates only when the phone is not flat.
    private(set) var hold: CameraPoseMath.ImageUp = .plusY
    private(set) var isStill = false
    private(set) var isCapturing = false
    /// Result of the on-device CoreMotion convention check (see
    /// `CameraPoseMath`), nil until the first sample.
    private(set) var conventionCheck: String?

    var gpsIsAmber: Bool {
        guard let location, location.horizontalAccuracy >= 0 else { return true }
        return location.horizontalAccuracy > Self.gpsAmberAboveM
    }

    var headingIsAmber: Bool {
        guard let headingAccuracyDeg, headingAccuracyDeg >= 0 else { return true }
        return headingAccuracyDeg > Self.headingAmberAboveDeg
    }

    // MARK: - Dependencies

    let camera = CameraController()
    @ObservationIgnored private let motion = CMMotionManager()
    @ObservationIgnored private let motionQueue: OperationQueue = {
        let q = OperationQueue()
        q.name = "golfmap.referencePhoto.motion"
        q.maxConcurrentOperationCount = 1
        return q
    }()
    @ObservationIgnored private var samples: [CameraPoseMath.MotionSample] = []
    @ObservationIgnored private var locationDelegate: LocationDelegate?
    @ObservationIgnored private var locationManager: CLLocationManager?

    // MARK: - Lifecycle

    func start() {
        startMotion()
        startLocation()
        Task {
            let setup = await camera.configure()
            switch setup {
            case .ready(let fov):
                longSideFovDeg = fov
                cameraState = .ready
            case .denied:
                cameraState = .denied
            case .unavailable(let reason):
                cameraState = .unavailable(reason)
            }
        }
    }

    func stop() {
        motion.stopDeviceMotionUpdates()
        locationManager?.stopUpdatingLocation()
        locationManager?.stopUpdatingHeading()
        camera.stop()
    }

    // MARK: - Motion

    private func startMotion() {
        guard motion.isDeviceMotionAvailable else {
            motionAvailable = false
            return
        }
        let frames = CMMotionManager.availableAttitudeReferenceFrames()
        startMotion(trueNorth: frames.contains(.xTrueNorthZVertical))
    }

    private func startMotion(trueNorth: Bool) {
        motion.stopDeviceMotionUpdates()
        usingTrueNorth = trueNorth
        samples.removeAll()
        motion.deviceMotionUpdateInterval = 1.0 / Self.motionHz
        // Explicitly @Sendable: a plain closure here would inherit @MainActor
        // isolation and trap when CoreMotion calls it on `motionQueue`.
        let handler: @Sendable (CMDeviceMotion?, Error?) -> Void = { [weak self] dm, error in
            if let error = error as NSError?, error.domain == CMErrorDomain, trueNorth {
                // True north needs a location fix; fall back to magnetic.
                Task { @MainActor [weak self] in self?.startMotion(trueNorth: false) }
                return
            }
            guard let dm else { return }
            let q = dm.attitude.quaternion
            let r = dm.attitude.rotationMatrix
            let quat = CameraPoseMath.Quat(w: q.w, x: q.x, y: q.y, z: q.z)
            let matrix = CameraPoseMath.Mat3(
                m11: r.m11, m12: r.m12, m13: r.m13,
                m21: r.m21, m22: r.m22, m23: r.m23,
                m31: r.m31, m32: r.m32, m33: r.m33
            )
            let gravity = CameraPoseMath.Vec3(x: dm.gravity.x, y: dm.gravity.y, z: dm.gravity.z)
            let rate = dm.rotationRate
            let sample = CameraPoseMath.MotionSample(
                timestamp: dm.timestamp,
                attitude: quat,
                rotationRateRadS: (rate.x * rate.x + rate.y * rate.y + rate.z * rate.z).squareRoot()
            )
            let calibration = Int(dm.magneticField.accuracy.rawValue)
            Task { @MainActor [weak self] in
                self?.ingest(sample, matrix: matrix, gravity: gravity, calibration: calibration)
            }
        }
        motion.startDeviceMotionUpdates(
            using: trueNorth ? .xTrueNorthZVertical : .xMagneticNorthZVertical,
            to: motionQueue,
            withHandler: handler
        )
    }

    private func ingest(
        _ sample: CameraPoseMath.MotionSample,
        matrix: CameraPoseMath.Mat3,
        gravity: CameraPoseMath.Vec3,
        calibration: Int
    ) {
        if conventionCheck == nil { checkConvention(sample.attitude, matrix: matrix, gravity: gravity) }
        samples.append(sample)
        if samples.count > Self.sampleBufferCount { samples.removeFirst(samples.count - Self.sampleBufferCount) }
        self.gravity = gravity
        magCalibration = calibration
        if let up = CameraPoseMath.ImageUp.from(gravity: gravity) { hold = up }
        let attitude = trueAttitude(sample.attitude)
        livePose = CameraPoseMath.pose(quaternion: attitude, imageUp: hold)
        screenPose = CameraPoseMath.pose(quaternion: attitude, imageUp: .plusY)
        isStill = CameraPoseMath.shutterWindow(
            samples: samples, now: sample.timestamp,
            windowS: Self.shutterWindowS, maxRotationRateRadS: Self.maxRotationRateRadS
        )?.isStationary ?? false
    }

    /// Compares CoreMotion's matrix and gravity with the convention
    /// `CameraPoseMath` assumes. Logged once per session.
    private func checkConvention(_ q: CameraPoseMath.Quat, matrix: CameraPoseMath.Mat3, gravity: CameraPoseMath.Vec3) {
        let matrixDiff = CameraPoseMath.matrix(from: q).maxAbsDifference(matrix)
        let g = matrix.gravityInDevice
        let gravityDiff = max(abs(g.x - gravity.x), abs(g.y - gravity.y), abs(g.z - gravity.z))
        let ok = matrixDiff < 0.01 && gravityDiff < 0.05
        conventionCheck = String(format: "%@ matrix %.4f gravity %.4f", ok ? "ok" : "MISMATCH", matrixDiff, gravityDiff)
        if ok {
            Self.log.info("pose convention ok: matrix diff \(matrixDiff), gravity diff \(gravityDiff)")
        } else {
            Self.log.error("pose convention MISMATCH: matrix diff \(matrixDiff), gravity diff \(gravityDiff)")
        }
    }

    /// The attitude in the true-north frame when possible.
    private func trueAttitude(_ q: CameraPoseMath.Quat) -> CameraPoseMath.Quat {
        guard !usingTrueNorth, let declinationDeg else { return q }
        return CameraPoseMath.applyingDeclination(q, declinationDeg: declinationDeg)
    }

    // MARK: - Location

    private func startLocation() {
        let manager = CLLocationManager()
        let delegate = LocationDelegate { [weak self] update in
            self?.apply(update)
        }
        manager.delegate = delegate
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.headingFilter = kCLHeadingFilterNone
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
        locationManager = manager
        locationDelegate = delegate
    }

    fileprivate enum LocationUpdate: Sendable {
        case location(CLLocation)
        case heading(accuracy: Double, trueHeading: Double, magneticHeading: Double)
    }

    private func apply(_ update: LocationUpdate) {
        switch update {
        case .location(let loc):
            location = loc
        case .heading(let accuracy, let trueHeading, let magneticHeading):
            headingAccuracyDeg = accuracy >= 0 ? accuracy : nil
            if trueHeading >= 0, accuracy >= 0 {
                var d = trueHeading - magneticHeading
                if d > 180 { d -= 360 }
                if d < -180 { d += 360 }
                declinationDeg = d
            }
        }
    }

    private final class LocationDelegate: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
        private let onUpdate: @MainActor @Sendable (LocationUpdate) -> Void

        init(onUpdate: @escaping @MainActor @Sendable (LocationUpdate) -> Void) {
            self.onUpdate = onUpdate
        }

        func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
            guard let last = locations.last else { return }
            let onUpdate = onUpdate
            Task { @MainActor in onUpdate(.location(last)) }
        }

        func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
            let update = LocationUpdate.heading(
                accuracy: newHeading.headingAccuracy,
                trueHeading: newHeading.trueHeading,
                magneticHeading: newHeading.magneticHeading
            )
            let onUpdate = onUpdate
            Task { @MainActor in onUpdate(update) }
        }
    }

    // MARK: - Shutter

    enum ShutterError: Error, Equatable {
        case cameraNotReady
        case noLocation
        case noMotion
        case capture(String)
        case files(String)
        case database(String)
    }

    struct ShutterInput: Sendable {
        var siteId: String
        var courseId: String?
        var hole: Int?
        var tags: [String]
        var note: String?
        var eyeHeightM: Double
    }

    /// Captures and stores one photo. Warnings (moving, poor accuracy) do not
    /// block it; they are recorded in the row (`isStationary`, `hAccM`,
    /// `headingAccDeg`).
    func capture(_ input: ShutterInput, database: AppDatabase, files: PhotoFiles) async -> Result<ReferencePhotoRecord, ShutterError> {
        guard cameraState == .ready, let fov = longSideFovDeg else { return .failure(.cameraNotReady) }
        guard let location, location.horizontalAccuracy >= 0 else { return .failure(.noLocation) }
        guard let newest = samples.last,
              let window = CameraPoseMath.shutterWindow(
                  samples: samples, now: newest.timestamp,
                  windowS: Self.shutterWindowS, maxRotationRateRadS: Self.maxRotationRateRadS
              )
        else { return .failure(.noMotion) }

        isCapturing = true
        defer { isCapturing = false }

        let capturedAt = Date()
        let holdAtPress = hold
        let trueNorth = usingTrueNorth
        let declination = declinationDeg
        let headingAcc = headingAccuracyDeg
        let calibration = magCalibration

        let data: Data
        do {
            data = try await camera.capture(rotationAngle: holdAtPress.videoRotationAngle)
        } catch {
            return .failure(.capture("\(error)"))
        }

        let id = UUID().uuidString.lowercased()
        let written: PhotoFiles.Written
        do {
            written = try await Task.detached(priority: .userInitiated) {
                try files.write(id: id, original: data)
            }.value
        } catch {
            return .failure(.files("\(error)"))
        }

        let imageUp = CameraPoseMath.ImageUp(exifOrientation: written.exifOrientation) ?? holdAtPress
        var attitude = window.attitude
        var north = PhotoNorthReference.trueNorth
        var appliedDeclination: Double?
        if !trueNorth {
            north = .magnetic
            if let declination {
                attitude = CameraPoseMath.applyingDeclination(attitude, declinationDeg: declination)
                appliedDeclination = declination
            }
        }
        let pose = CameraPoseMath.pose(quaternion: attitude, imageUp: imageUp)
        let fovs = CameraPoseMath.fieldOfView(longSideFovDeg: fov, width: written.width, height: written.height)

        let record = ReferencePhotoRecord(
            id: id,
            siteId: input.siteId,
            courseId: input.courseId,
            hole: input.hole,
            capturedAt: DeviceInfo.iso8601(capturedAt),
            lat: location.coordinate.latitude,
            lon: location.coordinate.longitude,
            hAccM: location.horizontalAccuracy,
            gpsAltM: location.verticalAccuracy >= 0 ? location.altitude : nil,
            vAccM: location.verticalAccuracy >= 0 ? location.verticalAccuracy : nil,
            quatW: attitude.w, quatX: attitude.x, quatY: attitude.y, quatZ: attitude.z,
            yawDeg: pose.yawDeg,
            pitchDeg: pose.pitchDeg,
            rollDeg: pose.rollDeg,
            headingAccDeg: headingAcc,
            magCalibration: calibration,
            hfovDeg: fovs.hfovDeg,
            vfovDeg: fovs.vfovDeg,
            width: written.width,
            height: written.height,
            eyeHeightM: input.eyeHeightM,
            deviceModel: DeviceInfo.modelIdentifier,
            lens: "wide",
            tags: input.tags,
            note: input.note,
            northReference: north,
            declinationDeg: appliedDeclination,
            imageUp: imageUp.rawValue,
            isStationary: window.isStationary,
            maxRotationRateRadS: window.maxRotationRateRadS,
            originalFile: written.originalFile,
            previewFile: written.previewFile,
            thumbnailFile: written.thumbnailFile,
            originalSha256: written.originalSha256,
            originalBytes: written.originalBytes,
            previewSha256: written.previewSha256,
            previewBytes: written.previewBytes,
            syncState: .pending,
            attemptCount: 0
        )
        do {
            try await database.saveReferencePhoto(record)
        } catch {
            return .failure(.database("\(error)"))
        }
        return .success(record)
    }
}
