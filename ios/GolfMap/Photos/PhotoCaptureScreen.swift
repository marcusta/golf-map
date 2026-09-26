import AVFoundation
import SwiftUI
import UIKit

/// Tags offered on the capture screen (doc §4.1). The raw value is what the
/// server stores.
enum PhotoTag: String, CaseIterable, Identifiable {
    case look, trees, bunker, green, water

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .look: return "eye"
        case .trees: return "tree"
        case .bunker: return "circle.dotted"
        case .green: return "flag"
        case .water: return "drop"
        }
    }

    var label: String { rawValue.capitalized }
}

/// Full-screen reference-photo capture (docs/feature-reference-photos.md
/// §4.1): a 4:3 preview with a horizon line and azimuth, GPS and heading
/// accuracy chips, hole and tag chips, a dictated note and the shutter. The
/// shutter never blocks: it turns amber when the phone moves or a fix is
/// poor, and the capture still happens.
struct PhotoCaptureScreen: View {
    let siteId: String
    let courseId: String?
    let holeLines: [NearestHole.Line]
    let onClose: () -> Void

    @Environment(AppEnvironment.self) private var env
    @State private var service = PhotoCaptureService()
    @State private var voice = VoiceCapture()
    /// Nil while the hole follows the nearest play line.
    @State private var pickedHole: Int?
    @State private var noHole = false
    @State private var tags: Set<PhotoTag> = [.look]
    @State private var note = ""
    @State private var toast: String?
    @State private var showList = false
    @State private var savedCount = 0

    private var autoHole: Int? {
        guard let loc = service.location else { return nil }
        return NearestHole.number(
            at: LatLon(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude),
            lines: holeLines
        )
    }

    private var hole: Int? { noHole ? nil : (pickedHole ?? autoHole) }

    private var shutterWarns: Bool {
        !service.isStill || service.gpsIsAmber || service.headingIsAmber || !service.usingTrueNorth
    }

    var body: some View {
        VStack(spacing: 12) {
            topBar
            preview
            chipRows
            Spacer(minLength: 0)
            bottomBar
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .overlay(alignment: .center) {
            if let toast {
                Text(toast)
                    .font(.headline)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .transition(.opacity)
            }
        }
        .onAppear { service.start() }
        .onDisappear {
            service.stop()
            _ = voice.stop()
        }
        .onChange(of: voice.transcript) { _, text in
            if voice.status == .listening { note = text }
        }
        .sheet(isPresented: $showList) {
            PhotoListScreen(siteId: siteId, onClose: { showList = false })
        }
        .accessibilityIdentifier("photoCaptureScreen")
    }

    // MARK: - Top bar

    private var topBar: some View {
        HStack(spacing: 8) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Close")
            Spacer()
            statusChip(
                symbol: "location.fill",
                text: service.location.map { String(format: "%.0f m", $0.horizontalAccuracy) } ?? "--",
                amber: service.gpsIsAmber
            )
            .accessibilityLabel("GPS accuracy")
            statusChip(
                symbol: service.usingTrueNorth ? "location.north.line" : "safari",
                text: service.headingAccuracyDeg.map { String(format: "%.0f°", $0) } ?? "--",
                amber: service.headingIsAmber || !service.usingTrueNorth
            )
            .accessibilityLabel(service.usingTrueNorth ? "Heading accuracy" : "Heading accuracy, magnetic north")
            Spacer()
            Button {
                showList = true
            } label: {
                Image(systemName: "photo.stack")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .overlay(alignment: .topTrailing) {
                        if savedCount > 0 {
                            Text("\(savedCount)")
                                .font(.caption2.bold())
                                .monospacedDigit()
                                .padding(.horizontal, 5)
                                .background(Color.statusInfo, in: Capsule())
                        }
                    }
            }
            .accessibilityLabel("Photos")
        }
        .foregroundStyle(.white)
    }

    private func statusChip(symbol: String, text: String, amber: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol)
            Text(text).monospacedDigit()
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(amber ? Color.black : Color.white)
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(amber ? Color.statusCaution : Color.white.opacity(0.15), in: Capsule())
    }

    // MARK: - Preview

    private var preview: some View {
        ZStack {
            switch service.cameraState {
            case .ready:
                CameraPreview(session: service.camera.session)
                HorizonLine(pose: service.screenPose, longSideFovDeg: service.longSideFovDeg)
            case .starting:
                Color.white.opacity(0.05)
                ProgressView().tint(.white)
            case .denied:
                placeholder(symbol: "video.slash", text: "Camera access off")
            case .unavailable:
                placeholder(symbol: "video.slash", text: "No camera")
            }
            VStack {
                Text(service.livePose.map { String(format: "%03.0f°", $0.yawDeg) } ?? "---°")
                    .font(.system(size: 44, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.6), radius: 3)
                    .accessibilityLabel("Azimuth")
                Spacer()
            }
            .padding(.top, 8)
        }
        .aspectRatio(3.0 / 4.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func placeholder(symbol: String, text: String) -> some View {
        ZStack {
            Color.white.opacity(0.05)
            VStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 36))
                Text(text).font(.headline)
            }
            .foregroundStyle(.white.opacity(0.7))
        }
    }

    // MARK: - Chips

    private var chipRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                holeMenu
                noteButton
                if !note.isEmpty {
                    Text(note)
                        .font(.footnote)
                        .lineLimit(2)
                        .foregroundStyle(.white.opacity(0.8))
                    Button {
                        note = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .frame(width: 32, height: 32)
                    }
                    .foregroundStyle(.white.opacity(0.6))
                    .accessibilityLabel("Clear note")
                }
                Spacer(minLength: 0)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(PhotoTag.allCases) { tag in
                        tagChip(tag)
                    }
                }
            }
        }
    }

    private var holeMenu: some View {
        Menu {
            Button {
                pickedHole = nil
                noHole = false
            } label: {
                Label(autoHole.map { "Nearest (\($0))" } ?? "Nearest", systemImage: "location")
            }
            Button("None") {
                pickedHole = nil
                noHole = true
            }
            ForEach(holeLines.map(\.number), id: \.self) { n in
                Button("\(n)") {
                    pickedHole = n
                    noHole = false
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "flag.fill")
                Text(hole.map(String.init) ?? "--").monospacedDigit()
                if pickedHole == nil && !noHole {
                    Image(systemName: "location.fill").font(.caption2)
                }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(Color.white.opacity(0.15), in: Capsule())
        }
        .accessibilityLabel("Hole")
    }

    private var noteButton: some View {
        let listening = voice.status == .listening
        return Button {
            if listening {
                if let text = voice.stop(), !text.isEmpty { note = text }
            } else {
                Task { await voice.start() }
            }
        } label: {
            Image(systemName: listening ? "mic.fill" : "mic")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(listening ? Color.black : Color.white)
                .frame(width: 36, height: 36)
                .background(listening ? Color.statusNegative : Color.white.opacity(0.15), in: Circle())
        }
        .disabled(voice.status == .denied || voice.status == .unavailable)
        .accessibilityLabel(listening ? "Stop note" : "Dictate note")
    }

    private func tagChip(_ tag: PhotoTag) -> some View {
        let on = tags.contains(tag)
        return Button {
            if on { tags.remove(tag) } else { tags.insert(tag) }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: tag.symbol)
                Text(tag.label)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(on ? Color.black : Color.white)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(on ? Color.white : Color.white.opacity(0.15), in: Capsule())
        }
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // MARK: - Shutter

    private var bottomBar: some View {
        ZStack {
            Button(action: shoot) {
                ZStack {
                    Circle()
                        .strokeBorder(shutterWarns ? Color.statusCaution : Color.white, lineWidth: 4)
                        .frame(width: 76, height: 76)
                    Circle()
                        .fill(service.isCapturing ? Color.gray : Color.white)
                        .frame(width: 62, height: 62)
                }
            }
            .disabled(service.cameraState != .ready || service.isCapturing)
            .opacity(service.cameraState == .ready ? 1 : 0.4)
            .accessibilityLabel("Shutter")
            .accessibilityIdentifier("photoShutter")

            HStack {
                Spacer()
                Image(systemName: service.isStill ? "hand.raised" : "hand.raised.slash")
                    .font(.system(size: 20))
                    .foregroundStyle(service.isStill ? Color.white.opacity(0.6) : Color.statusCaution)
                    .frame(width: 44, height: 44)
                    .accessibilityLabel(service.isStill ? "Steady" : "Moving")
            }
        }
        .padding(.bottom, 8)
    }

    private func shoot() {
        let input = PhotoCaptureService.ShutterInput(
            siteId: siteId,
            courseId: courseId,
            hole: hole,
            tags: PhotoTag.allCases.filter { tags.contains($0) }.map(\.rawValue),
            note: note.isEmpty ? nil : note,
            eyeHeightM: env.settings.photoEyeHeightM
        )
        Task {
            let result = await service.capture(input, database: env.database, files: env.photoFiles)
            switch result {
            case .success(let record):
                savedCount += 1
                note = ""
                var warnings: [String] = []
                if !record.isStationary { warnings.append("moved") }
                if record.hAccM > PhotoCaptureService.gpsAmberAboveM { warnings.append("GPS ±\(Int(record.hAccM)) m") }
                if record.northReference == .magnetic { warnings.append("magnetic") }
                show(warnings.isEmpty ? "Saved" : "Saved, " + warnings.joined(separator: ", "))
                PhotoUploadTrigger.flush(env.photoSync)
            case .failure(let error):
                show(Self.message(error))
            }
        }
    }

    private static func message(_ error: PhotoCaptureService.ShutterError) -> String {
        switch error {
        case .cameraNotReady: return "Camera not ready"
        case .noLocation: return "No GPS fix"
        case .noMotion: return "No motion data"
        case .capture: return "Capture failed"
        case .files: return "Could not save files"
        case .database: return "Could not save photo"
        }
    }

    private func show(_ text: String) {
        withAnimation { toast = text }
        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation { if toast == text { toast = nil } }
        }
    }
}

// MARK: - Horizon line

/// The level line of the world in the portrait preview. Pitch moves it off
/// center by f·tan(pitch), with f from the preview's vertical FOV (the long
/// side of the sensor); roll rotates it the opposite way.
private struct HorizonLine: View {
    let pose: CameraPoseMath.Pose?
    let longSideFovDeg: Double?

    var body: some View {
        GeometryReader { geo in
            if let pose, let fov = longSideFovDeg, abs(pose.pitchDeg) < fov / 2 {
                let halfH = geo.size.height / 2
                let f = halfH / tan(fov / 2 * .pi / 180)
                let dy = f * tan(pose.pitchDeg * .pi / 180)
                let level = abs(pose.rollDeg) < 1
                Rectangle()
                    .fill(level ? Color.statusPositive : Color.white.opacity(0.8))
                    .frame(width: geo.size.width * 2, height: 2)
                    .position(x: geo.size.width / 2, y: halfH + dy)
                    .rotationEffect(.degrees(-pose.rollDeg))
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Camera preview

private struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.backgroundColor = .black
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {
        // The app UI is portrait-only.
        if let connection = view.previewLayer.connection, connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        }
    }
}
