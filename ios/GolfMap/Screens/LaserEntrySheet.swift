import SwiftUI

/// The on-course card's one contextual laser entry (round-loop R7).
///
/// One spoken/typed number routes by the picked map context:
///  - no picked feature + plausible pin number → existing PinEntrySheet solve;
///  - picked feature + no live calibration → existing CalibrationSession;
///  - picked feature + live calibration → OriginCalibration residual gate.
///
/// Fixed-feature shots always publish `model.lastLaserCarryCheck`, including a
/// silently confirmed residual. A rejected residual remains here with the
/// re-shoot prompt while the existing card badge flips to stale.
struct LaserEntrySheet: View {
    @Bindable var model: OnCourseModel
    @Bindable var session: CalibrationSession
    let onClose: () -> Void

    @State private var voice = VoiceCapture()
    @State private var typed = ""
    @State private var message: Message?
    @State private var pinPhrase: String?

    private enum Message: Equatable {
        case invalid
        case needsFix
        case shotAdded(Int)
        case inconclusive
        case rejected
    }

    var body: some View {
        if let pinPhrase, let frame = model.currentGreenFrame {
            PinEntrySheet(
                model: model,
                frame: frame,
                initialPhrase: pinPhrase,
                onClose: onClose
            )
        } else {
            entry
        }
    }

    private var entry: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.s5) {
                    contextZone
                    inputZone
                    if let check = model.lastLaserCarryCheck {
                        carryCheck(check)
                    }
                    if session.phase == .trilateration {
                        sessionZone
                    }
                    if let message {
                        messageView(message)
                    }
                    if let (calibration, solution) = session.trilaterationResult {
                        solutionCard(calibration: calibration, solution: solution)
                    }
                }
                .padding(.horizontal, Space.s5)
                .padding(.top, Space.s2)
                .padding(.bottom, Space.s6)
            }
            .navigationTitle("Laser")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", action: close)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        // Same target picker as CalibrationSheet: Browse-mode map taps remain
        // live behind the medium sheet and update `model.browseTarget`.
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        .onChange(of: voice.status) { old, new in
            if old == .listening, new == .idle { submit(voice.transcript) }
        }
        .onDisappear { voice.stop() }
    }

    // MARK: - Context

    @ViewBuilder
    private var contextZone: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            OverlineLabel("What did you shoot?")
            if let target = model.browseTarget {
                Label(targetDescription(target), systemImage: "scope")
                    .font(.subheadline.weight(.semibold))
                Text(contextDescription)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Label("No mapped feature picked", systemImage: "flag.fill")
                    .font(.subheadline.weight(.semibold))
                Text(
                    "A plausible bare number places the pin. To calibrate or verify GPS, "
                    + "turn on Browse and tap the fixed feature first."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var contextDescription: String {
        switch model.calibrationStatus {
        case .active:
            return "Live calibration — this shot verifies it and checks the mapped carry."
        case .none, .stale:
            return "No live calibration — this shot joins the trilateration session and checks the mapped carry."
        }
    }

    private func targetDescription(_ target: LatLon) -> String {
        guard let fix = model.userLocation else { return "Mapped feature picked · waiting for GPS" }
        return String(format: "Mapped feature picked · ~%.0f m from GPS", Distance.planarMeters(fix, target))
    }

    // MARK: - Input

    private var inputZone: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            HStack(alignment: .top, spacing: Space.s3) {
                Button {
                    message = nil
                    if voice.status == .listening {
                        voice.stop()
                    } else {
                        Task { await voice.start() }
                    }
                } label: {
                    Image(systemName: voice.status == .listening ? "stop.fill" : "mic.fill")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(voice.status == .listening ? Color.white : Color.accentPrimary)
                        .frame(width: 56, height: 56)
                        .background(
                            voice.status == .listening
                                ? AnyShapeStyle(Color.statusNegative)
                                : AnyShapeStyle(Color.accentPrimary.opacity(0.15)),
                            in: Circle()
                        )
                }
                .buttonStyle(.plain)
                .disabled(voice.status == .denied || voice.status == .unavailable)
                .accessibilityLabel(voice.status == .listening ? "Stop listening" : "Say laser distance")

                VStack(alignment: .leading, spacing: Space.s2) {
                    Text(statusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    TextField("metres — e.g. 143", text: $typed)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                        .submitLabel(.done)
                        .onSubmit { submit(typed) }
                }
                .frame(maxWidth: .infinity)
            }

            Picker("Language", selection: localeBinding) {
                Text("English").tag(PinVoiceLocale.english)
                Text("Svenska").tag(PinVoiceLocale.swedish)
            }
            .pickerStyle(.segmented)

            Button("Use number") { submit(typed) }
                .buttonStyle(.borderedProminent)
                .disabled(PinPhraseParser.laserDistance(typed, locale: voice.locale) == nil)
        }
    }

    private var localeBinding: Binding<PinVoiceLocale> {
        Binding(get: { voice.locale }, set: { voice.locale = $0 })
    }

    private var statusText: String {
        switch voice.status {
        case .listening: return voice.transcript.isEmpty ? "Listening…" : "“\(voice.transcript)”"
        case .idle: return voice.transcript.isEmpty ? "Say or type the rangefinder number." : "“\(voice.transcript)”"
        case .denied: return "Speech access is off — type the number instead."
        case .unavailable: return "On-device speech is unavailable — type the number instead."
        }
    }

    // MARK: - Routing

    private func submit(_ phrase: String) {
        guard let metres = PinPhraseParser.laserDistance(phrase, locale: voice.locale) else {
            message = .invalid
            return
        }
        typed = phrase
        message = nil

        switch model.laserRoute(distanceM: metres) {
        case .pinDepth:
            pinPhrase = phrase
        case .calibrationShot:
            addCalibrationShot(distanceM: metres)
        case .residualCheck:
            guard let target = model.browseTarget else {
                message = .invalid
                return
            }
            switch model.registerLaserShot(distanceM: metres, target: target) {
            case .confirmed:
                // Silent refresh by decision: the carry check remains visible
                // on the card after this sheet closes.
                close()
            case .inconclusive:
                message = .inconclusive
            case .rejected:
                message = .rejected
            }
        case .unavailable:
            message = .invalid
        }
    }

    private func addCalibrationShot(distanceM: Double) {
        guard let target = model.browseTarget, let fix = model.userLocation else {
            message = .needsFix
            return
        }
        _ = model.recordLaserCarry(distanceM: distanceM, target: target)
        if session.phase != .trilateration {
            let raw = Sweref99TM.fromWGS84(fix)
            session.beginTrilateration(rawFixPlanar: Vec2(x: raw.x, y: raw.y), at: Date())
        }
        let feature = Sweref99TM.fromWGS84(target)
        session.addShot(
            featurePlanar: Vec2(x: feature.x, y: feature.y),
            laserDistanceM: distanceM
        )
        typed = ""
        message = .shotAdded(session.shots.count)
    }

    // MARK: - Results

    private func carryCheck(_ check: LaserCarryCheck) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            OverlineLabel("Carry check")
            Text(
                String(
                    format: "Laser %.1f m · map %.1f m · Δ %+.1f m",
                    check.laserDistanceM, check.mappedDistanceM, check.deltaM
                )
            )
            .font(.subheadline.weight(.semibold))
            .monospacedDigit()
        }
        .padding(Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: Radius.md))
    }

    private var sessionZone: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            OverlineLabel("Calibration shots")
            ForEach(Array(session.shots.enumerated()), id: \.offset) { index, shot in
                HStack {
                    Text("Shot \(index + 1)")
                    Spacer()
                    Text(String(format: "%.1f m", shot.laserDistanceM))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .font(.footnote)
            }
            if session.shots.count < 2 {
                Text("Pick another fixed feature at a wider angle, then open Laser again.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func messageView(_ message: Message) -> some View {
        let text: String
        let color: Color
        let icon: String
        switch message {
        case .invalid:
            text = "Enter a plausible rangefinder number. Without a picked feature, pin distance starts at 40 m."
            color = .statusCaution
            icon = "exclamationmark.triangle.fill"
        case .needsFix:
            text = "A mapped-feature calibration shot needs a live GPS fix. Re-shoot once GPS is available."
            color = .statusCaution
            icon = "exclamationmark.triangle.fill"
        case .shotAdded(let count):
            text = "Calibration shot \(count) added."
            color = .statusPositive
            icon = "checkmark.circle.fill"
        case .inconclusive:
            text = "Residual is near the gate. Re-shoot this feature or pick another fixed target."
            color = .statusCaution
            icon = "exclamationmark.triangle.fill"
        case .rejected:
            text = "Distances are uncalibrated. Re-shoot a fixed feature or use an anchor before trusting corrected distances."
            color = .statusCaution
            icon = "exclamationmark.triangle.fill"
        }
        return Label(text, systemImage: icon)
            .font(.footnote)
            .foregroundStyle(color)
    }

    private func solutionCard(
        calibration: OriginCalibration,
        solution: Trilateration.Solution
    ) -> some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            OverlineLabel("GPS bias solved")
            Text(CalibrationSheet.describeBias(e: calibration.biasE, n: calibration.biasN))
                .font(.title3.weight(.semibold))
                .monospacedDigit()
            Text(String(format: "Fit RMS %.1f m · confidence %.0f%%", solution.rmsResidualM, calibration.baseConfidence * 100))
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button("Apply calibration") {
                model.applyCalibration(calibration)
                session.reset()
                close()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: Radius.md))
    }

    private func close() {
        voice.stop()
        onClose()
    }
}
