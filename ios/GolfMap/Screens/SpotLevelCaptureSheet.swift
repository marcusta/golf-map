import SwiftUI

/// The spot-level capture UI: phone laid flat on the green, a live tilt bubble,
/// the settle state, the verdict colour, and Save → upload. One IMU level
/// reading = one calibration sample against the green DEM (doc §4.2).
///
/// Needs the `greenId` of the current hole; the entry point disables itself
/// when the hole has no green. Location (lat/lon + horizontal accuracy) is read
/// from the on-course `LocationProvider`.
///
/// Competition mode note: capturing a level is *measurement*, not advice, so
/// this sheet stays available in competition mode (unlike live green reads and
/// plays-like). The DMD rule concerns advice display; a level reading only
/// feeds calibration.
///
/// ── Seam for task D4 ────────────────────────────────────────────────────────
/// D4 builds the full green-read UI and will want this capture reachable from
/// there. It is intentionally a standalone sheet parameterised only by
/// `greenId` + a location closure + the API client, so D4 can present it with
/// `.sheet` from the read UI without any change here.
/// ────────────────────────────────────────────────────────────────────────────
struct SpotLevelCaptureSheet: View {
    let greenId: String
    /// Current best location fix for the payload; nil = no fix yet.
    let location: (latLon: LatLon, horizontalAccuracyM: Double)?
    let client: GolfAPIClient
    let onClose: () -> Void

    @State private var capture = SpotLevelCapture()
    @State private var uploadState: UploadState = .idle

    private enum UploadState: Equatable {
        case idle
        case uploading
        case uploaded
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Text("Lay the phone flat on the green and hold still.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                bubble

                readout

                statusLine

                Spacer()

                controls
            }
            .padding()
            .navigationTitle("Level")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        capture.cancel()
                        onClose()
                    }
                }
            }
        }
        .onAppear { capture.start() }
        .onDisappear { capture.cancel() }
    }

    // MARK: - Bubble (live tilt)

    /// A simple spirit-level bubble: the dot offsets from centre in proportion
    /// to the live tilt, in the downhill direction; it centres when flat.
    private var bubble: some View {
        let radius: CGFloat = 90
        // Map tilt (deg) to a fraction of the radius; ~3° fills the ring.
        let frac = min(capture.liveTiltDeg / 3.0, 1.0)
        let angle = capture.liveFallLineDeg * .pi / 180
        // Downhill compass bearing → screen offset (0°=up/north, clockwise).
        let dx = CGFloat(sin(angle)) * radius * CGFloat(frac)
        let dy = -CGFloat(cos(angle)) * radius * CGFloat(frac)
        return ZStack {
            Circle()
                .stroke(.secondary.opacity(0.4), lineWidth: 2)
                .frame(width: radius * 2, height: radius * 2)
            Circle()
                .stroke(.secondary.opacity(0.25), lineWidth: 1)
                .frame(width: radius, height: radius)
            Circle()
                .fill(verdictColor.opacity(0.85))
                .frame(width: 26, height: 26)
                .offset(x: dx, y: dy)
                .animation(.easeOut(duration: 0.1), value: dx)
                .animation(.easeOut(duration: 0.1), value: dy)
        }
        .frame(height: radius * 2 + 8)
    }

    // MARK: - Readout

    private var readout: some View {
        HStack(spacing: 28) {
            metric(
                label: "Slope",
                value: slopeText,
                unit: "%"
            )
            metric(
                label: "Fall line",
                value: capture.reading != nil || capture.liveTiltDeg > 0.1
                    ? "\(Int(displayFallLine.rounded()))"
                    : "–",
                unit: "°"
            )
        }
    }

    private func metric(label: String, value: String, unit: String) -> some View {
        VStack(spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(value)
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text(unit)
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
    }

    private var statusLine: some View {
        HStack(spacing: 8) {
            Circle().fill(verdictColor).frame(width: 10, height: 10)
            Text(statusText)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Controls

    @ViewBuilder
    private var controls: some View {
        switch uploadState {
        case .uploaded:
            Label("Saved", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(.green)
        case .uploading:
            ProgressView("Saving…")
        default:
            VStack(spacing: 12) {
                if case let .failed(message) = uploadState {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
                HStack(spacing: 12) {
                    Button {
                        uploadState = .idle
                        capture.start()
                    } label: {
                        Label("Re-read", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    Button {
                        Task { await save() }
                    } label: {
                        Label("Save", systemImage: "square.and.arrow.down")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSave)
                }
            }
        }
    }

    // MARK: - Save / upload

    private var canSave: Bool {
        capture.phase == .done
            && capture.reading != nil
            && capture.verdict != .red
            && location != nil
    }

    private func save() async {
        guard
            let reading = capture.reading,
            let verdict = capture.verdict,
            let location
        else { return }

        let payload = SpotLevelPayload(
            capturedAt: DeviceInfo.iso8601(),
            device: DeviceInfo.modelIdentifier,
            appVersion: DeviceInfo.appVersion,
            location: GreenScanLocation(
                lat: location.latLon.lat,
                lon: location.latLon.lon,
                horizontalAccuracyM: location.horizontalAccuracyM
            ),
            slopePct: reading.slopePct,
            fallLineBearingDeg: reading.fallLineBearingDeg,
            sampleDurationS: reading.durationS,
            sampleCount: reading.sampleCount,
            tiltStdDeg: reading.tiltStdDeg,
            headingAccuracyDeg: capture.headingAccuracyDeg ?? -1
        )
        let quality = GreenScanQuality(verdict: verdict)

        uploadState = .uploading
        do {
            try await client.postGreenScan(
                greenId: greenId,
                kind: .spotLevel,
                capturedAt: payload.capturedAt,
                payload: payload,
                quality: quality
            )
            uploadState = .uploaded
        } catch {
            uploadState = .failed((error as? APIError)?.errorDescription ?? "Upload failed.")
        }
    }

    // MARK: - Display helpers

    private var slopeText: String {
        if let reading = capture.reading {
            return String(format: "%.1f", reading.slopePct)
        }
        if capture.liveTiltDeg > 0.05 {
            return String(format: "%.1f", capture.liveSlopePct)
        }
        return "–"
    }

    private var displayFallLine: Double {
        capture.reading?.fallLineBearingDeg ?? capture.liveFallLineDeg
    }

    private var verdictColor: Color {
        switch capture.verdict {
        case .green: return .green
        case .yellow: return .yellow
        case .red: return .red
        case nil: return capture.isSettled ? .green : .secondary
        }
    }

    private var statusText: String {
        switch capture.phase {
        case .idle: return "Ready"
        case .settling: return "Hold still…"
        case .capturing: return "Reading…"
        case .unavailable: return "Motion sensor unavailable"
        case .done:
            switch capture.verdict {
            case .green: return "Good reading"
            case .yellow: return "Marginal — consider re-reading"
            case .red: return capture.headingAccuracyDeg.map { $0 } == nil || (capture.headingAccuracyDeg ?? 0) > SpotLevelCapture.maxHeadingAccuracyDeg
                ? "Compass needs calibration — figure-8 the phone"
                : "Wouldn't settle — try again"
            case nil: return "Done"
            }
        }
    }
}
