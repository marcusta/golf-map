import SwiftUI

/// The guided out-and-back LiDAR corridor-scan flow (task E1, doc §4.1):
/// anchor at the ball (static level) → walk BESIDE the line to the hole →
/// mark the hole (static level) → walk back → verdict. All capture logic
/// lives in `CorridorScanService`; all math in `CorridorFitMath`. This view
/// renders phase instructions, live progress, and the verdict screen with
/// the doc's semantics:
///
///  - green  → "Use read": installs the `ScannedSurface` through the
///             `PuttReadModel.installScannedSurface` seam + auto-uploads.
///  - yellow → re-scan suggested; using it is allowed (the surface carries a
///             softened confidence) + upload.
///  - red    → the read is REFUSED ("read it yourself"); the scan can still
///             be uploaded — the server stores red scans but never counts
///             them toward calibration.
///
/// The payload is assembled per the pinned wire structs
/// (`CorridorPayload` / `GreenScanQuality`) and posted via
/// `GolfAPIClient.postGreenScan`.
struct CorridorScanSheet: View {
    let greenId: String
    /// User-placed putt markers, EPSG:3006 — the scan surface's anchor AND
    /// the payload's ball/hole locations (converted to WGS84).
    let ballWorld: Vec2
    let holeWorld: Vec2
    /// Current GPS fix accuracy for the payload locations; nil = no fix.
    let location: (latLon: LatLon, horizontalAccuracyM: Double)?
    let client: GolfAPIClient
    /// Install an accepted scan as the read surface (green/yellow only).
    let onUse: (ScannedSurface) -> Void
    let onClose: () -> Void

    @State private var service = CorridorScanService()
    @State private var uploadState: UploadState = .idle

    private enum UploadState: Equatable {
        case idle
        case uploading
        case uploaded
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                content
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.surfaceApp.ignoresSafeArea())
            .navigationTitle("Corridor scan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        service.cancel()
                        onClose()
                    }
                }
            }
        }
        .onAppear { service.start() }
        .onDisappear { service.cancel() }
    }

    // MARK: - Phase content

    @ViewBuilder
    private var content: some View {
        switch service.phase {
        case .idle:
            ProgressView("Starting camera…")
        case .unavailable:
            ContentUnavailableView(
                "No LiDAR on this device",
                systemImage: "camera.metering.unknown",
                description: Text("Corridor scanning needs the LiDAR scanner (iPhone Pro models).")
            )
        case .anchorBall:
            stepView(
                step: 1,
                title: "Anchor the ball",
                instruction: "Stand at the ball and hold the phone over it, camera facing the green.",
                buttonLabel: "Anchor ball",
                action: { service.anchorBall() }
            )
        case .levelBall:
            levelView(title: "Level at the ball", onConfirm: { service.confirmBallLevel() })
        case .readyToWalkOut:
            stepView(
                step: 2,
                title: "Walk to the hole",
                instruction: "Pick the phone up. Walk BESIDE the putt line — on the high side, never on it — with the camera facing the grass.",
                buttonLabel: "Start walking",
                action: { service.beginWalkOut() }
            )
        case .walkOut:
            walkView(
                title: "Walking out…",
                instruction: "Keep the phone facing the green, a step to the high side of the line. At the hole, tap Mark hole.",
                buttonLabel: "Mark hole",
                action: { service.markHole() }
            )
        case .levelHole:
            levelView(title: "Level at the hole", onConfirm: { service.confirmHoleLevel() })
        case .readyToWalkBack:
            stepView(
                step: 3,
                title: "Walk back",
                instruction: "Pick the phone up and walk back to the ball along the same side. The return pass is the quality check.",
                buttonLabel: "Start walking back",
                action: { service.beginWalkBack() }
            )
        case .walkBack:
            walkView(
                title: "Walking back…",
                instruction: "Same side, camera on the grass. Back at the ball, tap Finish.",
                buttonLabel: "Finish",
                action: { service.finish() }
            )
        case .fitting:
            ProgressView("Fitting the surface…")
        case .done:
            if let result = service.result {
                verdictView(result)
            }
        case .failed(let message):
            VStack(spacing: 16) {
                ContentUnavailableView(
                    "Scan unusable",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
                Button {
                    service.cancel()
                    service.start()
                } label: {
                    Label("Re-scan", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
    }

    // MARK: - Step / walk / level building blocks

    private func stepView(
        step: Int,
        title: String,
        instruction: String,
        buttonLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 16) {
            OverlineLabel("Step \(step) of 3")
            Text(title)
                .font(.title3.weight(.semibold))
            Text(instruction)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button(action: action) {
                Text(buttonLabel)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
        }
    }

    private func walkView(
        title: String,
        instruction: String,
        buttonLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 16) {
            Text(title)
                .font(.title3.weight(.semibold))
            Text(instruction)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 28) {
                walkMetric(
                    label: "From ball",
                    value: String(format: "%.1f", service.distanceFromBallM),
                    unit: "m"
                )
                walkMetric(
                    label: "Surface points",
                    value: pointCountText
                )
            }
            .padding(.top, 8)
            Spacer()
            Button(action: action) {
                Text(buttonLabel)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
        }
    }

    /// Live point-coverage hint: rough density feedback while walking.
    private var pointCountText: String {
        let count = service.pointCount
        if count >= 10_000 { return "\(count / 1000)k" }
        return "\(count)"
    }

    private func walkMetric(label: String, value: String, unit: String? = nil) -> some View {
        VStack(spacing: 4) {
            MetricText(value, unit: unit, size: 34)
            OverlineLabel(label, size: 10)
        }
    }

    /// The static endpoint level (reused D2 capture) with live tilt readout.
    private func levelView(title: String, onConfirm: @escaping () -> Void) -> some View {
        let capture = service.level
        return VStack(spacing: 16) {
            Text(title)
                .font(.title3.weight(.semibold))
            Text("Lay the phone flat on the green and hold still.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 8) {
                Circle().fill(levelColor).frame(width: 10, height: 10)
                Text(levelStatusText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if capture.phase == .done, let reading = capture.reading {
                VStack(spacing: 4) {
                    MetricText(String(format: "%.1f", reading.slopePct), unit: "%", size: 34)
                    OverlineLabel("slope", size: 10)
                }
            } else {
                VStack(spacing: 4) {
                    MetricText(String(format: "%.1f", capture.liveSlopePct), unit: "%",
                               size: 34, color: .secondary)
                    OverlineLabel("slope", size: 10)
                }
            }
            Spacer()
            if capture.phase == .done {
                if capture.verdict == .red {
                    Button {
                        service.retryLevel()
                    } label: {
                        Label("Try again", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                } else {
                    Button(action: onConfirm) {
                        Text("Continue")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
            }
        }
    }

    private var levelColor: Color {
        switch service.level.verdict {
        case .green: return .green
        case .yellow: return .yellow
        case .red: return .red
        case nil: return service.level.isSettled ? .green : .secondary
        }
    }

    private var levelStatusText: String {
        switch service.level.phase {
        case .idle: return "Ready"
        case .settling: return "Hold still…"
        case .capturing: return "Reading…"
        case .unavailable: return "Motion sensor unavailable"
        case .done:
            switch service.level.verdict {
            case .green: return "Good reading"
            case .yellow: return "Marginal reading"
            case .red: return "Wouldn't settle — try again"
            case nil: return "Done"
            }
        }
    }

    // MARK: - Verdict screen (doc §4.1 semantics)

    private func verdictView(_ result: CorridorScanService.ScanComputation) -> some View {
        VStack(spacing: 14) {
            HStack(spacing: 8) {
                Circle().fill(verdictColor(result.verdict)).frame(width: 12, height: 12)
                Text(verdictTitle(result.verdict))
                    .font(.title3.weight(.semibold))
            }
            Text(verdictMessage(result.verdict))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            qcGrid(result)

            Spacer()

            switch uploadState {
            case .uploading:
                ProgressView("Saving scan…")
            case .uploaded:
                Label("Saved", systemImage: "checkmark.circle.fill")
                    .font(.headline)
                    .foregroundStyle(Color.statusPositive)
            default:
                if case let .failed(message) = uploadState {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(Color.statusNegative)
                        .multilineTextAlignment(.center)
                }
                verdictButtons(result)
            }
        }
    }

    private func qcGrid(_ result: CorridorScanService.ScanComputation) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        return VStack(spacing: 4) {
            qcRow("Pass mismatch", String(format: "%.2f", result.passMismatchSlopePct), unit: "% slope")
            qcRow("Fit residual", String(format: "%.0f", result.combined.rmseM * 1000), unit: "mm")
            qcRow("Line coverage", String(format: "%.0f", result.combinedCoverageFrac * 100), unit: "%")
            qcRow("Endpoint levels Δ", String(format: "%.2f", result.endpointLevelDeltaPct), unit: "% slope")
            qcRow("Line length", String(format: "%.1f", result.lineLengthM), unit: "m")
            qcRow("Points kept", "\(result.payloadPoints.count)")
        }
        .padding(Space.s3)
        .background(Color.surfaceCard, in: shape)
        .overlay(shape.strokeBorder(Color.borderSubtle, lineWidth: 1))
    }

    private func qcRow(_ label: String, _ value: String, unit: String? = nil) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            MetricText(value, unit: unit, size: 12)
        }
    }

    @ViewBuilder
    private func verdictButtons(_ result: CorridorScanService.ScanComputation) -> some View {
        switch result.verdict {
        case .green:
            VStack(spacing: 10) {
                Button {
                    useScan(result)
                } label: {
                    Label("Use read", systemImage: "checkmark.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                rescanButton
            }
        case .yellow:
            VStack(spacing: 10) {
                rescanButton
                Button {
                    useScan(result)
                } label: {
                    Label("Use anyway (softened)", systemImage: "checkmark.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        case .red:
            VStack(spacing: 10) {
                rescanButton
                Button {
                    Task { await upload(result) }
                } label: {
                    Label("Save scan only", systemImage: "square.and.arrow.down")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        }
    }

    private var rescanButton: some View {
        Button {
            uploadState = .idle
            service.cancel()
            service.start()
        } label: {
            Label("Re-scan", systemImage: "arrow.clockwise")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(SecondaryButtonStyle())
    }

    private func verdictColor(_ verdict: GreenScanVerdict) -> Color {
        switch verdict {
        case .green: return .green
        case .yellow: return .yellow
        case .red: return .red
        }
    }

    private func verdictTitle(_ verdict: GreenScanVerdict) -> String {
        switch verdict {
        case .green: return "Good scan"
        case .yellow: return "Marginal scan"
        case .red: return "Scan rejected"
        }
    }

    private func verdictMessage(_ verdict: GreenScanVerdict) -> String {
        switch verdict {
        case .green:
            return "The out and back passes agree — the slope read is trustworthy."
        case .yellow:
            return "The passes disagree a little — a re-scan is suggested. You can use the read; it will be softened."
        case .red:
            return "The passes disagree too much for a trustworthy read — read it yourself. The scan can still be saved for green calibration."
        }
    }

    // MARK: - Use / upload

    /// Install the scanned surface through the E1 seam, then upload. The
    /// install is never blocked by the network — the scan's on-course value
    /// is local; the upload is calibration.
    private func useScan(_ result: CorridorScanService.ScanComputation) {
        guard let confidence = ScannedSurface.confidence(for: result.verdict),
              let surface = ScannedSurface(
                  coefficients: result.combined.coefficients,
                  xMin: result.xMin, xMax: result.xMax,
                  yMin: result.yMin, yMax: result.yMax,
                  ballWorld: ballWorld, holeWorld: holeWorld,
                  confidence: confidence
              )
        else { return }
        onUse(surface)
        Task {
            await upload(result)
            onClose()
        }
    }

    private func upload(_ result: CorridorScanService.ScanComputation) async {
        guard let ballLevel = service.ballLevel, let holeLevel = service.holeLevel else { return }
        let capturedAt = DeviceInfo.iso8601()
        let ballLL = Sweref99TM.toWGS84(x: ballWorld.x, y: ballWorld.y)
        let holeLL = Sweref99TM.toWGS84(x: holeWorld.x, y: holeWorld.y)
        // Marker positions are user-placed on the map; the GPS fix accuracy
        // is the honest error proxy for them (no fix → a conservative 5 m).
        let accuracy = location?.horizontalAccuracyM ?? 5.0

        func fitPayload(_ fit: CorridorFitMath.Poly2Fit, coverage: Double) -> CorridorFit {
            CorridorFit(
                type: "poly2",
                coefficients: fit.coefficients,
                rmseM: fit.rmseM,
                corridorWidthM: CorridorFitMath.corridorHalfWidthM * 2,
                coverageFrac: coverage
            )
        }

        func levelPayload(
            _ reading: SpotLevelMath.Reading,
            at position: LatLon,
            headingAccuracyDeg: Double?
        ) -> SpotLevelPayload {
            SpotLevelPayload(
                capturedAt: capturedAt,
                device: DeviceInfo.modelIdentifier,
                appVersion: DeviceInfo.appVersion,
                location: GreenScanLocation(
                    lat: position.lat, lon: position.lon, horizontalAccuracyM: accuracy
                ),
                slopePct: reading.slopePct,
                fallLineBearingDeg: reading.fallLineBearingDeg,
                sampleDurationS: reading.durationS,
                sampleCount: reading.sampleCount,
                tiltStdDeg: reading.tiltStdDeg,
                headingAccuracyDeg: headingAccuracyDeg ?? -1
            )
        }

        // Compass-derived bearing when available; else the marker-derived
        // line bearing (compass degrees of ball→hole, EPSG:3006 east/north).
        let markerBearing = SpotLevelMath.wrap360(
            atan2(holeWorld.x - ballWorld.x, holeWorld.y - ballWorld.y) * 180 / .pi
        )

        let payload = CorridorPayload(
            capturedAt: capturedAt,
            device: DeviceInfo.modelIdentifier,
            appVersion: DeviceInfo.appVersion,
            ball: GreenScanLocation(lat: ballLL.lat, lon: ballLL.lon, horizontalAccuracyM: accuracy),
            hole: GreenScanLocation(lat: holeLL.lat, lon: holeLL.lon, horizontalAccuracyM: accuracy),
            endpointLevels: [
                levelPayload(ballLevel, at: ballLL, headingAccuracyDeg: service.ballLevelHeadingAccuracyDeg),
                levelPayload(holeLevel, at: holeLL, headingAccuracyDeg: service.holeLevelHeadingAccuracyDeg),
            ],
            frame: CorridorFrame(
                originalLineBearingDeg: service.lineBearingDeg ?? markerBearing,
                lineLengthM: result.lineLengthM
            ),
            points: result.payloadPoints,
            fit: fitPayload(result.combined, coverage: result.combinedCoverageFrac),
            passes: [
                CorridorPass(direction: "out", fit: fitPayload(result.outFit, coverage: result.outCoverageFrac)),
                CorridorPass(direction: "back", fit: fitPayload(result.backFit, coverage: result.backCoverageFrac)),
            ],
            passMismatchSlopePct: result.passMismatchSlopePct
        )
        let quality = GreenScanQuality(
            verdict: result.verdict,
            passMismatchSlopePct: result.passMismatchSlopePct,
            rmseM: result.combined.rmseM,
            coverageFrac: result.combinedCoverageFrac,
            endpointLevelDeltaPct: result.endpointLevelDeltaPct
        )

        uploadState = .uploading
        do {
            _ = try await client.postGreenScan(
                greenId: greenId,
                kind: .corridor,
                capturedAt: capturedAt,
                payload: payload,
                quality: quality
            )
            uploadState = .uploaded
        } catch {
            uploadState = .failed((error as? APIError)?.errorDescription ?? "Upload failed.")
        }
    }
}
