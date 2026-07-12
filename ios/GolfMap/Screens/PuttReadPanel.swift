import SwiftUI

/// The putt-read section of the Green view panel (doc §5.1): Surface (Tier 2,
/// terrain-tile DEM) / Manual (Tier 3, Tour Read arithmetic) segmented modes,
/// the readout (plays-like, aim offset, and the Tour Read verbal ALWAYS
/// alongside), a stimp control, the tap-target picker (Ball / Hole), the
/// Manual estimate form, and the small "Level" affordance that presents the
/// D2 spot-level capture sheet. All logic lives in `PuttReadModel` (headless);
/// this view only renders `model.display`.
///
/// Competition mode: the section collapses to a one-line "reads off" note —
/// the green view itself (slope/height overlay) stays, and Level stays
/// available (measurement, not advice; see AppSettings).
struct PuttReadSection: View {
    let model: PuttReadModel
    /// Training-quiz state (doc §5.1) — estimate the read before it's
    /// revealed, then see it scored. Headless; this view only renders it.
    let quiz: PuttQuizModel
    /// API client for the quiz's fire-and-forget scored-sample POST.
    let client: GolfAPIClient
    /// The active hole's green id (nil for a Tier-3 manual read with no
    /// surface) — attached to the recorded sample.
    let greenId: String?
    /// The green-analysis terrain sampling is still in flight — the Surface
    /// tier's grid hasn't resolved yet.
    let surfaceLoading: Bool
    /// Present the spot-level capture sheet (owned by the screen).
    let onLevel: () -> Void
    /// Present the LiDAR corridor-scan flow (task E1) — nil hides the Scan
    /// affordance entirely (no LiDAR/sceneDepth on this device). The button
    /// is disabled until both putt markers are placed: the scan surface
    /// anchors to them.
    var onScan: (() -> Void)?

    var body: some View {
        let display = model.display
        let quizGate = quiz.quizActive(groundTruth: display.groundTruth)
        VStack(spacing: 8) {
            header(display)
            if display.status == .competition {
                Text(display.message ?? "Competition mode — reads off.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                if let note = model.calibrationNote {
                    calibrationBadge(note)
                }
                if display.mode == .manual {
                    manualForm
                } else {
                    surfaceContent(display)
                }
                // While the quiz gates a readable putt, WITHHOLD the read
                // (exact tier + Tour Read verbal both) so the estimate is
                // honest — mirrors the web's `gate` check in `bindPuttSection`.
                if quizGate {
                    quizForm(display)
                } else {
                    readout(display)
                    if let result = quiz.lastResult {
                        scoreBlock(result)
                    }
                }
                stimpRow
            }
        }
        // Ball/hole reposition or stimp change → the quiz resets to
        // "estimate first" for the new putt (matches the web's puttSig
        // effect). A background grid refresh or competition-mode flip is
        // NOT in this signature, so it doesn't spuriously reset an
        // in-progress estimate.
        .onChange(of: model.puttSignature, initial: true) { _, sig in
            quiz.notePuttSignature(sig)
        }
    }

    // MARK: - Header (title + tier picker + level)

    private func header(_ display: PuttReadModel.Display) -> some View {
        HStack(spacing: 8) {
            Label("Putt", systemImage: "scope")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.cyan)
            Spacer()
            if display.status != .competition {
                // Quiz is advice-adjacent (it trains reading the same slope/
                // break/aim/pace the read shows) — hidden entirely in
                // competition mode, like the tier picker right next to it.
                // The toggle itself is always tappable here; its EFFECT
                // (withholding the read behind an estimate form) only
                // engages once a live, un-softened-to-nothing read exists —
                // see `quizActive(groundTruth:)`.
                Toggle("Quiz", isOn: Binding(
                    get: { quiz.enabled },
                    set: { quiz.enabled = $0 }
                ))
                .toggleStyle(.switch)
                .font(.caption2)
                .fixedSize()
                .accessibilityIdentifier("putt-quiz-toggle")
                Picker("Read tier", selection: Binding(
                    get: { model.mode },
                    set: { model.setMode($0) }
                )) {
                    Text("Surface").tag(PuttReadModel.ReadMode.surface)
                    Text("Manual").tag(PuttReadModel.ReadMode.manual)
                }
                .pickerStyle(.segmented)
                .frame(width: 150)
                .disabled(!model.hasSurface && !surfaceLoading)
            }
            if let onScan {
                Button(action: onScan) {
                    Label("Scan", systemImage: "dot.radiowaves.left.and.right")
                        .font(.caption.weight(.semibold))
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(model.ball == nil || model.hole == nil)
                .accessibilityLabel("Scan the putt corridor")
            }
            Button(action: onLevel) {
                Label("Level", systemImage: "level")
                    .font(.caption.weight(.semibold))
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.bordered)
            .controlSize(.mini)
            .accessibilityLabel("Level the green")
        }
    }

    /// Subtle "Calibrated · N scans" line: this green's read is corrected +
    /// confidence-lifted by accepted phone scans (doc §4.2). Explains why a
    /// calibrated green reads confident where a bare terrain-tile green is
    /// softened. Nil (uncalibrated / competition) → the row isn't shown.
    private func calibrationBadge(_ note: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "checkmark.seal.fill")
                .font(.caption2)
                .foregroundStyle(.green)
            Text(note)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Surface (Tier 2)

    @ViewBuilder
    private func surfaceContent(_ display: PuttReadModel.Display) -> some View {
        if surfaceLoading, !model.hasSurface {
            HStack(spacing: 8) {
                ProgressView()
                Text("Sampling terrain…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            if let message = display.message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(display.status == .unavailable ? .red : .secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            placeTargetRow
        }
    }

    /// Which marker the next map tap moves (both markers stay re-tappable).
    private var placeTargetRow: some View {
        HStack(spacing: 8) {
            Text("Tap places")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("Tap places", selection: Binding(
                get: { model.placeTarget },
                set: { model.setPlaceTarget($0) }
            )) {
                Text("Ball").tag(PuttReadModel.PlaceTarget.ball)
                Text("Hole").tag(PuttReadModel.PlaceTarget.hole)
            }
            .pickerStyle(.segmented)
            .frame(width: 130)
            Spacer()
            Text("drag markers to adjust")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Manual (Tier 3) form

    private var manualForm: some View {
        VStack(spacing: 6) {
            if !model.hasSurface, !surfaceLoading {
                Text("No terrain data for this green — manual read.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            stepperRow(
                label: "Length",
                value: lengthText,
                onDecrement: { model.setManualLength(model.manualLength - lengthStep) },
                onIncrement: { model.setManualLength(model.manualLength + lengthStep) }
            ) {
                Picker("Unit", selection: Binding(
                    get: { model.manualLengthUnit },
                    set: { switchLengthUnit($0) }
                )) {
                    Text("m").tag(PuttReadModel.ManualLengthUnit.meters)
                    Text("paces").tag(PuttReadModel.ManualLengthUnit.paces)
                }
                .pickerStyle(.segmented)
                .frame(width: 110)
            }
            stepperRow(
                label: "Slope",
                value: String(format: "%.1f %%", model.manualSlopePct),
                onDecrement: { model.setManualSlopePct(model.manualSlopePct - 0.5) },
                onIncrement: { model.setManualSlopePct(model.manualSlopePct + 0.5) }
            ) {
                Picker("Break", selection: Binding(
                    get: { model.manualBreakToRight },
                    set: { model.setManualBreakToRight($0) }
                )) {
                    Text("Breaks L").tag(false)
                    Text("Breaks R").tag(true)
                }
                .pickerStyle(.segmented)
                .frame(width: 150)
            }
            stepperRow(
                label: "Grade",
                value: String(
                    format: "%@%.1f %%",
                    model.manualGradePct > 0 ? "+" : "", model.manualGradePct
                ),
                onDecrement: { model.setManualGradePct(model.manualGradePct - 0.5) },
                onIncrement: { model.setManualGradePct(model.manualGradePct + 0.5) }
            ) {
                Text(model.manualGradePct >= 0 ? "uphill" : "downhill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Keep the physical putt length when flipping the unit (6 m ↔ 6.6 paces).
    private func switchLengthUnit(_ unit: PuttReadModel.ManualLengthUnit) {
        guard unit != model.manualLengthUnit else { return }
        let length = model.manualLength
        model.setManualLengthUnit(unit)
        model.setManualLength(
            unit == .paces ? metersToPaces(length) : length * PACE_METERS
        )
    }

    private var lengthText: String {
        model.manualLengthUnit == .paces
            ? String(format: "%.0f paces", model.manualLength)
            : String(format: "%.1f m", model.manualLength)
    }

    private var lengthStep: Double {
        model.manualLengthUnit == .paces ? 1 : 0.5
    }

    private func stepperRow(
        label: String,
        value: String,
        onDecrement: @escaping () -> Void,
        onIncrement: @escaping () -> Void,
        @ViewBuilder trailing: () -> some View
    ) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 44, alignment: .leading)
            Button(action: onDecrement) {
                Image(systemName: "minus.circle.fill").font(.system(size: 18))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            MetricText(value, size: 12)
                .frame(minWidth: 62)
            Button(action: onIncrement) {
                Image(systemName: "plus.circle.fill").font(.system(size: 18))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            Spacer()
            trailing()
        }
    }

    // MARK: - Training quiz (doc §5.1)

    /// Live ball→hole distance from the LIVE marker geometry, straight from
    /// `model.ball`/`model.hole` (not the settled read) — mirrors the web
    /// quiz prompt, which tracks the cursor mid-drag even while the read is
    /// pending. Nil until both markers are placed.
    private var puttDistanceM: Double? {
        guard let b = model.ball, let h = model.hole else { return nil }
        return hypot(h.x - b.x, h.y - b.y)
    }

    /// The estimate form — shown INSTEAD of the readout while the quiz gates
    /// a readable putt. Compact steppers for slope %, break side, aim offset
    /// (cm), and plays-like (m); Reveal & score / Skip actions.
    private func quizForm(_ display: PuttReadModel.Display) -> some View {
        VStack(spacing: 6) {
            Text(puttDistanceM.map { String(format: "Your read first — %.1f m putt", $0) }
                ?? "Your read first — place the ball")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
            stepperRow(
                label: "Slope",
                value: String(format: "%.1f %%", quiz.slopePct),
                onDecrement: { quiz.setSlopePct(quiz.slopePct - 0.5) },
                onIncrement: { quiz.setSlopePct(quiz.slopePct + 0.5) }
            ) {
                Picker("Break", selection: Binding(
                    get: { quiz.breakSide },
                    set: { quiz.setBreakSide($0) }
                )) {
                    Text("L").tag(BreakSide.left)
                    Text("—").tag(BreakSide.straight)
                    Text("R").tag(BreakSide.right)
                }
                .pickerStyle(.segmented)
                .frame(width: 110)
            }
            stepperRow(
                label: "Aim",
                value: String(format: "%.0f cm", quiz.aimOffsetCm),
                onDecrement: { quiz.setAimOffsetCm(quiz.aimOffsetCm - 5) },
                onIncrement: { quiz.setAimOffsetCm(quiz.aimOffsetCm + 5) }
            ) {
                Text("+ = right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            stepperRow(
                label: "Plays",
                value: String(format: "%.1f m", quiz.playsLikeM),
                onDecrement: { quiz.setPlaysLikeM(quiz.playsLikeM - 0.5) },
                onIncrement: { quiz.setPlaysLikeM(quiz.playsLikeM + 0.5) }
            ) {
                EmptyView()
            }
            HStack(spacing: 8) {
                Button("Reveal & score") {
                    quiz.submit(
                        truth: display.groundTruth,
                        greenId: greenId,
                        distanceM: puttDistanceM ?? 0,
                        stimpFt: model.stimpFt,
                        client: client
                    )
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.mini)
                Button("Skip") { quiz.skip() }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                Spacer()
            }
        }
    }

    /// Per-component + total score, shown alongside the readout once the
    /// quiz has scored an estimate this putt (nil after Skip — nothing was
    /// submitted). Mirrors the web `scoreHtml()` text exactly.
    private func scoreBlock(_ result: PuttEstimateScoreResult) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                readoutTitle("Score")
                Spacer()
                MetricText("\(result.score)", unit: "/100", size: 13)
            }
            Text(
                "Slope off \(String(format: "%.1f", result.slopeErrorPct))% · "
                    + "break \(result.breakSideCorrect ? "✓" : "✗") · "
                    + "aim off \(Int((result.aimErrorM * 100).rounded()))cm · "
                    + "pace off \(String(format: "%.1f", result.paceErrorM))m"
            )
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.cyan.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Readout

    /// Plays-like + aim from the active tier, with the Tour Read verbal ALWAYS
    /// alongside (doc §5.1 — the on-course takeaway and sanity cross-check).
    @ViewBuilder
    private func readout(_ display: PuttReadModel.Display) -> some View {
        if display.mode == .manual, let message = display.message {
            // Manual can't-stop note (surface messages are shown above).
            Text(message)
                .font(.footnote)
                .foregroundStyle(.orange)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        if display.read != nil || display.tour != nil {
            HStack(alignment: .top, spacing: 12) {
                if let read = display.read {
                    // Exact tier (integrator).
                    VStack(alignment: .leading, spacing: 2) {
                        readoutTitle(display.status == .soft ? "Read (rough)" : "Read")
                        readoutRow("Aim", aimText(read.aimOffsetM))
                        readoutRow("Plays like", String(format: "%.1f", read.playsLikeM), unit: "m")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let verbal = display.verbal {
                    // Tour Read verbal — always shown alongside.
                    VStack(alignment: .leading, spacing: 2) {
                        readoutTitle("Tour read")
                        Text(verbal.aim)
                            .font(.caption.weight(.semibold))
                        Text(verbal.pace)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func readoutTitle(_ text: String) -> some View {
        OverlineLabel(text, size: 10)
    }

    private func readoutRow(_ label: String, _ value: String, unit: String? = nil) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 6)
            MetricText(value, unit: unit, size: 12)
        }
    }

    /// Exact-tier aim offset, metric, 5 cm steps (same rounding spirit as
    /// `formatTourRead` — a read is never centimeter-precise).
    private func aimText(_ aimOffsetM: Double) -> String {
        let cm = (abs(aimOffsetM) * 100 / 5).rounded() * 5
        if cm == 0 { return "straight" }
        return String(format: "%.0f cm %@", cm, aimOffsetM > 0 ? "right" : "left")
    }

    // MARK: - Stimp

    private var stimpRow: some View {
        HStack(spacing: 8) {
            Text("Stimp")
                .font(.caption)
                .foregroundStyle(.secondary)
            Slider(
                value: Binding(
                    get: { model.stimpFt },
                    set: { model.setStimp(($0 * 2).rounded() / 2) }
                ),
                in: PuttReadModel.stimpMinFt...PuttReadModel.stimpMaxFt
            )
            MetricText(String(format: "%.1f", model.stimpFt), size: 12)
                .frame(width: 32, alignment: .trailing)
        }
    }
}
