import AVFoundation
import Foundation

/// Owns the `AVCaptureSession` for reference photos: back wide (1x) camera
/// only, zoom fixed at 1, `AVCapturePhotoOutput` producing HEIC (D-RP3). All
/// AVFoundation calls run on `queue`; the type is `@unchecked Sendable` because
/// its mutable state is only touched there.
///
/// `builtInWideAngleCamera` is a physical device, so the system never swaps
/// lenses behind the app's back the way a virtual (dual/triple) device does.
final class CameraController: NSObject, @unchecked Sendable {
    enum Setup: Sendable, Equatable {
        /// `longSideFovDeg` is `activeFormat.videoFieldOfView` at zoom 1.
        case ready(longSideFovDeg: Double)
        case denied
        case unavailable(String)
    }

    enum CaptureError: Error, Equatable {
        case notConfigured
        case noData
        case failed(String)
    }

    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "golfmap.referencePhoto.camera")
    private var configured = false
    private var inFlight: [Int64: PhotoDelegate] = [:]

    func configure() async -> Setup {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else { return .denied }
        default:
            return .denied
        }
        return await withCheckedContinuation { cont in
            queue.async { cont.resume(returning: self.configureOnQueue()) }
        }
    }

    private func configureOnQueue() -> Setup {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            return .unavailable("No back camera")
        }
        do {
            session.beginConfiguration()
            defer { session.commitConfiguration() }
            session.sessionPreset = .photo
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input), session.canAddOutput(output) else {
                return .unavailable("Camera busy")
            }
            session.addInput(input)
            session.addOutput(output)
            output.maxPhotoQualityPrioritization = .quality
            if let largest = device.activeFormat.supportedMaxPhotoDimensions
                .max(by: { Int($0.width) * Int($0.height) < Int($1.width) * Int($1.height) }) {
                output.maxPhotoDimensions = largest
            }
        } catch {
            return .unavailable("Camera input: \(error.localizedDescription)")
        }
        do {
            try device.lockForConfiguration()
            device.videoZoomFactor = 1
            device.unlockForConfiguration()
        } catch {
            return .unavailable("Camera lock: \(error.localizedDescription)")
        }
        configured = true
        session.startRunning()
        return .ready(longSideFovDeg: Double(device.activeFormat.videoFieldOfView))
    }

    func stop() {
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    /// Captures one HEIC. `rotationAngle` is `ImageUp.videoRotationAngle`, so
    /// the file's EXIF orientation matches how the phone was held.
    func capture(rotationAngle: Double) async throws -> Data {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            queue.async {
                guard self.configured else {
                    cont.resume(throwing: CaptureError.notConfigured)
                    return
                }
                let settings: AVCapturePhotoSettings
                if self.output.availablePhotoCodecTypes.contains(.hevc) {
                    settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.hevc])
                } else {
                    settings = AVCapturePhotoSettings()
                }
                settings.maxPhotoDimensions = self.output.maxPhotoDimensions
                settings.photoQualityPrioritization = .quality
                if let connection = self.output.connection(with: .video),
                   connection.isVideoRotationAngleSupported(rotationAngle) {
                    connection.videoRotationAngle = rotationAngle
                }
                let id = settings.uniqueID
                // Holds the controller until the photo is delivered.
                let delegate = PhotoDelegate { result in
                    self.queue.async { self.inFlight[id] = nil }
                    cont.resume(with: result)
                }
                self.inFlight[id] = delegate
                self.output.capturePhoto(with: settings, delegate: delegate)
            }
        }
    }

    private final class PhotoDelegate: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
        private let completion: (Result<Data, Error>) -> Void
        private var done = false

        init(completion: @escaping (Result<Data, Error>) -> Void) {
            self.completion = completion
        }

        func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
            guard !done else { return }
            done = true
            if let error {
                completion(.failure(CaptureError.failed(error.localizedDescription)))
            } else if let data = photo.fileDataRepresentation() {
                completion(.success(data))
            } else {
                completion(.failure(CaptureError.noData))
            }
        }
    }
}
