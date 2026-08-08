import SwiftUI

/// Phase-2 GPS origin calibration (docs/feature-laser-pin-and-calibration.md
/// §6.2 / §6.3): the UI over `CalibrationSession` that solves the additive
/// GPS bias and installs it via `model.applyCalibration`. Presented at a
/// medium detent with background interaction enabled, so the player can tap
/// map features (Browse mode) between steps without dismissing.
///
/// Two mutually exclusive flows behind a segmented picker:
///  - **I am here** (anchor, §6.2): pick a known point (active tee — weak; or
///    the browse target — mapped), hold still while a short burst of raw
///    fixes averages out; bias = anchor − mean fix.
///  - **Laser shots** (trilateration, §6.3): laser 2–3 fixed mapped features
///    from where you stand; least-squares recovers the 2D bias.
///
/// The session owns no clock and no location plumbing: this sheet pumps raw
/// fixes into it on a ~3 Hz timer pull (`liveLocation`) and stamps them with
/// the wall clock — the UI layer is the one place `Date()` is allowed.
///
/// MVP anchor picking is deliberately NOT map plumbing: there is no anchor
/// furniture type yet (spec §6.2 fallback), so the two offered anchors are
/// the active tee (`.weak` — tee markers move daily) and the browse target
/// the player tapped (`.mapped` — ortho-mapped point, ~1 m class).
struct CalibrationSheet: View {
    @Bindable var model: OnCourseModel
    /// Live raw fix + reported horizontal accuracy, pulled (not pushed) by the
    /// anchor capture loop. A closure over `LocationProvider` rather than a
    /// snapshot so the loop always reads the CURRENT fix — the view value it
    /// captured at task start would be frozen. Same raw fix as
    /// `model.userLocation`; the provider adds the accuracy the session's
    /// capture-quality warning needs. MainActor-typed: the implementation
    /// reads `LocationProvider`'s isolated properties, and the pump only ever
    /// calls it from the main actor.
    let liveLocation: @MainActor () -> (latLon: LatLon, horizontalAccuracyM: Double)?
    let onClose: () -> Void

    /// The calibration state machine (anchor burst / trilateration solve).
    @State private var session = CalibrationSession()
    @State private var mode: Mode = .anchor
    /// The ~3 Hz anchor fix pump; cancelled on stop/cancel/mode switch.
    @State private var pumpTask: Task<Void, Never>?
    /// Typed laser distance for the next trilateration shot.
    @State private var laserText = ""
    /// Detent, driven so "Pick the target on the map" can get out of the way:
    /// background interaction is only enabled up through `.medium`, so the
    /// sheet must shrink before the map underneath is tappable.
    @State private var detent: PresentationDetent = .large
    /// Focus on the metres field, so picking a target can dismiss the keyboard
    /// (it covers the map the player is being sent to tap).
    @FocusState private var laserFieldFocused: Bool

    enum Mode: Hashable { case anchor, laser }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.s5) {
                    modePicker
                    switch mode {
                    case .anchor: anchorZone
                    case .laser: laserZone
                    }
                }
                .padding(.horizontal, Space.s5)
                .padding(.top, Space.s2)
                .padding(.bottom, Space.s6)
            }
            .navigationTitle("Calibrate GPS")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                }
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        // Keep the map tappable behind the medium detent: both flows ask the
        // player to tap a feature in Browse mode mid-flow (anchor source /
        // next laser target), and a modal wall would force close-tap-reopen.
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        // Switching method abandons the in-flight flow — beginAnchor /
        // beginTrilateration reset the session anyway, but the pump must die
        // and a half-captured burst must not linger behind the other tab.
        .onChange(of: mode) { _, _ in abandonFlow() }
        .onDisappear { abandonFlow() }
    }

    private var modePicker: some View {
        Picker("Method", selection: $mode) {
            Text("I am here").tag(Mode.anchor)
            Text("Laser shots").tag(Mode.laser)
        }
        .pickerStyle(.segmented)
    }

    // MARK: - Anchor flow (spec §6.2)

    @ViewBuilder
    private var anchorZone: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            OverlineLabel("Stand on a known point")
            Text("Stand on a mapped point and hold still.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            if model.userLocation == nil {
                hint("Waiting for a GPS fix — there is nothing to average yet.")
            }

            anchorSourceRow(
                title: "Use active tee",
                subtitle: "Tee markers move daily — a weak anchor.",
                systemImage: "flag",
                enabled: activeTeePosition != nil && model.userLocation != nil
            ) {
                if let tee = activeTeePosition {
                    startAnchor(at: tee, quality: .weak)
                }
            }

            anchorSourceRow(
                title: "Use browse target",
                subtitle: model.browseTarget != nil
                    ? "The mapped point you tapped — hold still on it."
                    : "Turn on Browse and tap the point you're standing on first.",
                systemImage: "mappin.and.ellipse",
                enabled: model.browseTarget != nil && model.userLocation != nil
            ) {
                if let target = model.browseTarget {
                    startAnchor(at: target, quality: .mapped)
                }
            }
        }

        if session.phase == .anchor {
            if let result = session.anchorResult {
                resultCard(
                    calibration: result,
                    warnings: session.captureQualityWarning
                        ? ["The capture was jittery or low-accuracy — confidence reduced."]
                        : []
                )
            } else {
                captureZone
            }
        }
    }

    /// Progress ring + warnings while the fix burst averages out.
    private var captureZone: some View {
        VStack(spacing: Space.s3) {
            OverlineLabel("Hold still")
            ZStack {
                Circle()
                    .stroke(Color.white.opacity(0.12), lineWidth: 6)
                Circle()
                    .trim(from: 0, to: session.fixProgress)
                    .stroke(
                        Color.accentPrimary,
                        style: StrokeStyle(lineWidth: 6, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
                Text("\(Int((session.fixProgress * 100).rounded()))%")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .monospacedDigit()
            }
            .frame(width: 72, height: 72)
            .animation(.easeInOut(duration: 0.3), value: session.fixProgress)

            Text("Averaging GPS fixes…")
                .font(.footnote)
                .foregroundStyle(.secondary)

            if session.captureQualityWarning {
                Label(
                    "GPS is jumpy — hold still and step clear of trees.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption)
                .foregroundStyle(Color.statusCaution)
            }

            Button("Stop", role: .cancel) { abandonFlow() }
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
    }

    /// The current hole's active tee (honouring overrides) — the weak-anchor
    /// fallback that always exists on a mapped hole.
    private var activeTeePosition: LatLon? {
        model.currentHole.flatMap { model.teePosition(for: $0) }
    }

    private func anchorSourceRow(
        title: String,
        subtitle: String,
        systemImage: String,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: Space.s3) {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(enabled ? Color.accentPrimary : Color.secondary)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
            }
            .padding(.horizontal, Space.s3)
            .padding(.vertical, Space.s2)
            .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.md))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
    }

    /// Begin the anchor burst and start the timer-driven fix pump: every
    /// 0.35 s (~3 Hz, matching the session's "8 fixes ≈ 2–3 s" sizing) pull
    /// the latest raw fix, project it to EPSG:3006, and feed it to the
    /// session stamped with the wall clock. The loop ends itself the moment
    /// `anchorResult` solves (or on cancel).
    private func startAnchor(at anchor: LatLon, quality: CalibrationSession.AnchorQuality) {
        pumpTask?.cancel()
        let p = Sweref99TM.fromWGS84(anchor)
        session.beginAnchor(at: Vec2(x: p.x, y: p.y), quality: quality)
        pumpTask = Task {
            while !Task.isCancelled, session.anchorResult == nil {
                if let live = liveLocation() {
                    let fix = Sweref99TM.fromWGS84(live.latLon)
                    session.addFix(
                        e: fix.x,
                        n: fix.y,
                        horizontalAccuracyM: live.horizontalAccuracyM,
                        at: Date()
                    )
                }
                try? await Task.sleep(nanoseconds: 350_000_000)
            }
        }
    }

    // MARK: - Trilateration flow (spec §6.3)

    // Opportunistic §6.4 checks now enter through the card's one Laser button
    // (T36 / LaserEntrySheet). This explicit calibration tool stays focused on
    // deliberately collecting a fresh trilateration solve.
    @ViewBuilder
    private var laserZone: some View {
        VStack(alignment: .leading, spacing: Space.s4) {
            HStack(alignment: .firstTextBaseline) {
                OverlineLabel("Laser fixed features")
                Spacer()
                Text("\(session.shots.count) of 2–3")
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(session.shots.count >= 2
                                     ? Color.statusPositive : Color.textSecondary)
            }
            Text("Stand still. Laser 2–3 fixed, mapped features spread widely "
                 + "around you — a narrow fan only pins one axis.")
                .font(.footnote)
                .foregroundStyle(Color.textSecondary)

            if model.userLocation == nil {
                hint(
                    "No GPS fix yet — trilateration corrects the fix, "
                    + "so it needs one to start from."
                )
            } else {
                if !session.shots.isEmpty { shotList }
                addShotCard
                spreadHint
            }
        }

        if let (calibration, solution) = session.trilaterationResult {
            resultCard(
                calibration: calibration,
                warnings: trilaterationWarnings(solution),
                detail: String(format: "Fit RMS %.1f m over %d shots",
                               solution.rmsResidualM, session.shots.count)
            )
        }
    }

    /// One row per captured shot. Each row names the direction it was shot in
    /// and echoes the GPS-implied distance next to the lasered one: two shots
    /// are otherwise indistinguishable ("Shot 1", "Shot 2"), and a lasered
    /// distance far off the mapped one means the wrong feature was tapped —
    /// exactly the mistake that poisons the solve.
    @ViewBuilder
    private var shotList: some View {
        VStack(spacing: Space.s2) {
            ForEach(Array(session.shots.enumerated()), id: \.offset) { index, shot in
                HStack(spacing: Space.s3) {
                    Text("\(index + 1)")
                        .font(.caption.weight(.bold))
                        .monospacedDigit()
                        .frame(width: 24, height: 24)
                        .background(Color.textSecondary.opacity(0.2), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(String(format: "%.1f m lasered", shot.laserDistanceM))
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                        Text(shotDetail(shot))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(Color.textSecondary)
                    }
                    Spacer()
                    Button {
                        session.removeShot(at: index)
                    } label: {
                        Image(systemName: "trash")
                            .font(.footnote)
                            .foregroundStyle(Color.statusNegative)
                            .padding(Space.s2)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove shot \(index + 1)")
                }
                .padding(.horizontal, Space.s3)
                .padding(.vertical, Space.s2)
                .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.md))
            }
        }
    }

    /// The one live step: pick a target, then type its lasered distance. The
    /// two halves are never shown at once — picking needs the map (sheet down,
    /// keyboard away), typing needs the keyboard — so the card shows only the
    /// step the player is actually on.
    @ViewBuilder
    private var addShotCard: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            if let target = model.browseTarget {
                Label(targetLine(target), systemImage: "mappin.and.ellipse")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.textPrimary)
                Text("Laser that feature and type the metres.")
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
                HStack(spacing: Space.s3) {
                    TextField("metres", text: $laserText)
                        .keyboardType(.decimalPad)
                        .focused($laserFieldFocused)
                        .font(.title3.monospacedDigit())
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 140)
                        .submitLabel(.done)
                    Button("Add shot") { addShot() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(parsedLaserMetres == nil)
                }
                Button("Pick a different target") { pickTargetOnMap() }
                    .font(.footnote)
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.statusInfo)
            } else {
                Button {
                    pickTargetOnMap()
                } label: {
                    Label("Pick the target on the map", systemImage: "hand.tap")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Text("Drops this sheet and switches the map to Browse. "
                     + "Tap the feature you are lasering, then come back here.")
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)
            }
        }
        .padding(Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.md))
    }

    /// Get out of the way of the tap: browse mode is what makes a map tap set
    /// `browseTarget` at all, the keyboard covers the map, and background
    /// interaction only reaches through at the medium detent.
    private func pickTargetOnMap() {
        model.setGPSEnabled(false)
        laserFieldFocused = false
        detent = .medium
    }

    /// "NE · 48 m by GPS" — direction from the current fix plus the mapped
    /// distance, measured now (the player stands still through the flow).
    private func shotDetail(_ shot: Trilateration.Shot) -> String {
        guard let fix = model.userLocation else { return "Captured" }
        let p = Sweref99TM.fromWGS84(fix)
        let dx = shot.featurePlanar.x - p.x
        let dy = shot.featurePlanar.y - p.y
        let distance = (dx * dx + dy * dy).squareRoot()
        let bearing = (atan2(dx, dy) * 180 / .pi).truncatingRemainder(dividingBy: 360)
        return String(format: "%@ · %.0f m by GPS",
                      Self.compassPoint(bearing < 0 ? bearing + 360 : bearing),
                      distance)
    }

    private static let compassPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

    /// 8-point compass label for a 0…360 clockwise-from-north bearing.
    static func compassPoint(_ bearingDeg: Double) -> String {
        let index = Int((bearingDeg / 45).rounded()) % 8
        return compassPoints[(index + 8) % 8]
    }

    @ViewBuilder
    private var spreadHint: some View {
        if let spread = session.angularSpreadDeg,
           spread < CalibrationSession.Constants.minAngularSpreadDeg {
            Label(
                String(format: "Shots span only %.0f° — shots too aligned, pick a wider angle.",
                       spread),
                systemImage: "angle"
            )
            .font(.caption)
            .foregroundStyle(Color.statusCaution)
        }
    }

    /// "Target picked · ~143 m away by GPS" — a sanity echo that the tapped
    /// point is plausibly the thing being lasered.
    private func targetLine(_ target: LatLon) -> String {
        guard let fix = model.userLocation else { return "Target picked" }
        let d = Distance.planarMeters(fix, target)
        return String(format: "Target picked · ~%.0f m away by GPS", d)
    }

    private func trilaterationWarnings(_ solution: Trilateration.Solution) -> [String] {
        var warnings: [String] = []
        if solution.weakAxis {
            warnings.append(
                "Shots too aligned — only one axis is constrained, so the bias "
                + "was projected onto it. Low confidence; add a wider-angle shot."
            )
        }
        if solution.rmsResidualM > CalibrationSession.Constants.rmsResidualScaleM / 2 {
            warnings.append("Shots disagree — a feature may be misidentified or a distance misread.")
        }
        return warnings
    }

    /// Add the typed laser distance against the current browse target. The
    /// trilateration flow is begun lazily on the FIRST shot so the raw-fix
    /// seed is captured as close to shooting time as possible.
    private func addShot() {
        guard let target = model.browseTarget, let metres = parsedLaserMetres else { return }
        if session.phase != .trilateration {
            guard let fix = model.userLocation else { return }
            let p = Sweref99TM.fromWGS84(fix)
            session.beginTrilateration(rawFixPlanar: Vec2(x: p.x, y: p.y), at: Date())
        }
        let f = Sweref99TM.fromWGS84(target)
        session.addShot(featurePlanar: Vec2(x: f.x, y: f.y), laserDistanceM: metres)
        laserText = ""
    }

    /// Typed metres, tolerant of a decimal comma (Swedish keyboard). Bounded
    /// to plausible laser range so a fat-fingered "1430" can't poison a solve.
    private var parsedLaserMetres: Double? {
        let normalized = laserText
            .replacingOccurrences(of: ",", with: ".")
            .trimmingCharacters(in: .whitespaces)
        guard let value = Double(normalized), value > 0, value <= 1200 else { return nil }
        return value
    }

    // MARK: - Result card (shared)

    private func resultCard(
        calibration: OriginCalibration,
        warnings: [String],
        detail: String? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            OverlineLabel("Solved GPS bias")
            Text(Self.describeBias(e: calibration.biasE, n: calibration.biasN))
                .font(.title3.weight(.semibold))
                .monospacedDigit()
            HStack(spacing: Space.s3) {
                Text("Confidence \(Int((calibration.baseConfidence * 100).rounded()))%")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            ForEach(warnings, id: \.self) { warning in
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Color.statusCaution)
            }
            Button {
                apply(calibration)
            } label: {
                Text("Apply calibration")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(Space.s3)
        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.md))
    }

    /// "2.3 m east, 1.1 m south" — the bias as the player reads a map.
    static func describeBias(e: Double, n: Double) -> String {
        String(
            format: "%.1f m %@, %.1f m %@",
            abs(e), e >= 0 ? "east" : "west",
            abs(n), n >= 0 ? "north" : "south"
        )
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Color.statusCaution)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Lifecycle

    /// Install the solved bias — `origin` and every distance downstream pick
    /// it up on the next read — then close.
    private func apply(_ calibration: OriginCalibration) {
        model.applyCalibration(calibration)
        abandonFlow()
        onClose()
    }

    private func cancel() {
        abandonFlow()
        onClose()
    }

    /// Kill the fix pump and clear all captured session state.
    private func abandonFlow() {
        pumpTask?.cancel()
        pumpTask = nil
        session.reset()
        laserText = ""
    }
}

// MARK: - Status chip (control rail)

/// Compact calibration badge for the on-course control rail, driven by
/// `model.calibrationStatus`: hidden when uncalibrated-by-default (`.none`),
/// green "GPS ✓ NN%" while a bias is live and applied, amber "Uncalibrated"
/// once it decays or is invalidated (spec §6.4 — raw GPS with an honest
/// badge). Tapping it opens the same calibration sheet as the rail button.
struct CalibrationStatusChip: View {
    let status: OnCourseModel.CalibrationStatus
    let action: () -> Void

    var body: some View {
        switch status {
        case .none:
            EmptyView()
        case .active(let confidence):
            chip(
                // "✓ NN%" — the confidence in the correction. "±NN%" would
                // misread as a claimed error bound.
                text: "GPS ✓ \(Int((confidence * 100).rounded()))%",
                color: Color.statusPositive,
                icon: "scope",
                label: "GPS calibrated, confidence \(Int((confidence * 100).rounded())) percent"
            )
        case .stale:
            chip(
                text: "Uncalibrated",
                color: Color.statusCaution,
                icon: "exclamationmark.triangle.fill",
                label: "GPS calibration stale — distances uncalibrated"
            )
        }
    }

    private func chip(text: String, color: Color, icon: String, label: String) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .bold))
                Text(text)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .monospacedDigit()
            }
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .frame(height: 28)
            // Capsule variant of `.mapControl()` (which is circle-shaped).
            .background(Overlay.controlFill, in: Capsule())
            .background(.ultraThinMaterial, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityHint("Opens GPS calibration")
    }
}
