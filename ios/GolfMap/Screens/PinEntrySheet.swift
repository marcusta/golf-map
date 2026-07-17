import SwiftUI

/// Phase-1 pin entry (docs/feature-laser-pin-and-calibration.md §4.1, §5): the
/// fast, voice-first way to place today's pin from a pin sheet, a laser shot, or
/// a visual estimate. Reached from the distance card's pin button, presented at
/// a medium detent so the map + card stay visible behind it.
///
/// Three zones, top to bottom:
///  - **Input** — a mic driving on-device `VoiceCapture`, a typed fallback, and a
///    language toggle. Both paths end at `PinPhraseParser.parse`.
///  - **Candidates** — the parser returns *ranked interpretations*; one resolves
///    immediately, several become tappable rows, none is an honest "didn't catch
///    that" rather than a guess.
///  - **Confirm** — the chosen pin drawn on a schematic top-down green,
///    draggable to fine-tune, with a live metres echo. Commit is one tap. A
///    misparse is a drag-fix, never a silent wrong distance (L2).
///
/// The frame is captured at presentation (the card only opens the sheet when
/// `model.currentGreenFrame != nil`); it and `model.resolvePinPhrase` /
/// `PinPlacementSolver.pinWGS84` share the same green geometry, so the dot the
/// player drags and the WGS84 pin that gets committed stay consistent.
struct PinEntrySheet: View {
    @Bindable var model: OnCourseModel
    /// The current hole's green-local frame, snapshotted at presentation.
    let frame: GreenFrame
    /// Optional phrase handed off by the card's contextual laser entry. It is
    /// parsed once through the exact same candidate/solve path as mic or typed
    /// input, preserving PinEntrySheet's confirm-before-commit contract.
    var initialPhrase: String? = nil
    let onClose: () -> Void

    /// On-device dictation, owned for the sheet's lifetime. Its `locale` is the
    /// one source of truth for both recognition and text-fallback parsing.
    @State private var voice = VoiceCapture()
    @State private var typed = ""
    /// Ranked interpretations from the last parse (0 / 1 / many drives the
    /// candidate zone).
    @State private var candidates: [PinPhrase] = []
    /// The candidate currently resolved into the confirm sketch (highlighted in
    /// a multi-candidate list).
    @State private var selected: PinPhrase?
    /// True once an input has been submitted — gates the "didn't catch that"
    /// hint so it doesn't show before the player has tried anything.
    @State private var attempted = false
    /// The resolved + possibly dragged placement driving the confirm zone.
    @State private var working: PinSpec?
    /// The laser-mismatch flag from the solve (spec §3.2); cleared once the
    /// player drags the pin themselves.
    @State private var workingClamped = false
    /// A `.laser` phrase was picked but there is no origin to solve depth from
    /// (raw GPS off / browse with no fix) — surfaced as a hint, not a crash.
    @State private var laserNeedsOrigin = false
    @State private var consumedInitialPhrase = false

    /// The map-marker pin yellow, matched to the distance card + on-map pin.
    private static let pinColor = Color(red: 1.0, green: 0.83, blue: 0.23)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.s5) {
                    inputZone
                    candidateZone
                    if let working {
                        confirmZone(working)
                    }
                }
                .padding(.horizontal, Space.s5)
                .padding(.top, Space.s2)
                .padding(.bottom, Space.s6)
            }
            .navigationTitle("Place pin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: dismiss)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        // The recognizer auto-finishes (final result / silence timeout) by
        // dropping `.listening` → `.idle`; a manual mic tap does the same via
        // `stop()`. Either way, parse the settled transcript here.
        .onChange(of: voice.status) { old, new in
            if old == .listening, new == .idle { parse(voice.transcript) }
        }
        .onAppear {
            guard !consumedInitialPhrase, let initialPhrase else { return }
            consumedInitialPhrase = true
            typed = initialPhrase
            parse(initialPhrase)
        }
        .onDisappear { voice.stop() }
    }

    // MARK: - Input

    private var inputZone: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            OverlineLabel("Say the pin")
            HStack(alignment: .top, spacing: Space.s3) {
                micButton
                statusLine
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Picker("Language", selection: localeBinding) {
                Text("English").tag(PinVoiceLocale.english)
                Text("Svenska").tag(PinVoiceLocale.swedish)
            }
            .pickerStyle(.segmented)

            // Gloved-hand fallback for when dictation misfires or is unavailable.
            TextField("type it: 4 from front, 5 from left", text: $typed)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.done)
                .onSubmit { parse(typed) }
        }
    }

    private var micButton: some View {
        Button {
            if voice.status == .listening {
                voice.stop()
            } else {
                resetInterpretations()
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
        .accessibilityLabel(voice.status == .listening ? "Stop listening" : "Start listening")
    }

    @ViewBuilder
    private var statusLine: some View {
        switch voice.status {
        case .listening:
            Text(voice.transcript.isEmpty ? "Listening…" : voice.transcript)
                .font(.callout)
                .foregroundStyle(.primary)
        case .idle:
            if voice.transcript.isEmpty {
                Text("Tap the mic and say the pin — e.g. “four from front, five from left”.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Text("“\(voice.transcript)”")
                    .font(.callout)
                    .foregroundStyle(.primary)
            }
        case .denied:
            Text("Microphone or speech access is off — type the pin below instead.")
                .font(.footnote)
                .foregroundStyle(Color.statusCaution)
        case .unavailable:
            Text("On-device dictation isn't available for this language — type the pin below.")
                .font(.footnote)
                .foregroundStyle(Color.statusCaution)
        }
    }

    /// Reads/writes the recognizer locale (also the parser's locale). Setting it
    /// mid-capture is a no-op inside `VoiceCapture`; it takes effect next `start()`.
    private var localeBinding: Binding<PinVoiceLocale> {
        Binding(get: { voice.locale }, set: { voice.locale = $0 })
    }

    // MARK: - Candidates

    @ViewBuilder
    private var candidateZone: some View {
        if candidates.count > 1 {
            VStack(alignment: .leading, spacing: Space.s2) {
                OverlineLabel("Which did you mean?")
                ForEach(Array(candidates.enumerated()), id: \.offset) { _, phrase in
                    candidateRow(phrase)
                }
            }
        } else if laserNeedsOrigin {
            hint(
                "No GPS origin yet, so a laser distance can't be turned into depth. "
                + "Use a sheet (“4 from front, 5 from left”) or a visual phrase — or calibrate first."
            )
        } else if candidates.isEmpty, attempted {
            hint("Didn't catch that — try “4 from front, 5 from left”, or tap the mic again.")
        }
    }

    private func candidateRow(_ phrase: PinPhrase) -> some View {
        let isSelected = phrase == selected
        return Button {
            resolve(phrase)
        } label: {
            HStack {
                Text(describe(phrase))
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: isSelected ? "checkmark.circle.fill" : "chevron.right")
                    .font(.footnote)
                    .foregroundStyle(isSelected ? Color.accentPrimary : Color.secondary)
            }
            .padding(.horizontal, Space.s3)
            .padding(.vertical, Space.s2)
            .background(
                (isSelected ? Color.accentPrimary.opacity(0.12) : Color.white.opacity(0.06)),
                in: RoundedRectangle(cornerRadius: Radius.md)
            )
        }
        .buttonStyle(.plain)
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Confirm

    private func confirmZone(_ spec: PinSpec) -> some View {
        VStack(spacing: Space.s3) {
            OverlineLabel("Confirm — drag to fine-tune")
            GreenSketch(frame: frame, spec: spec) { dragged in
                working = dragged
                // A hand-placed pin overrides the laser mismatch — the player
                // has told us where it is, so the warning no longer applies.
                workingClamped = false
            }
            .frame(height: 220)
            .frame(maxWidth: .infinity)

            echoLine(spec)

            if workingClamped {
                Label(
                    "Laser doesn't fit this green from your position — check GPS/calibration.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption)
                .foregroundStyle(Color.statusCaution)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button {
                let position = PinPlacementSolver.pinWGS84(spec: spec, frame: frame)
                model.commitPin(at: position, source: spec.source)
                dismiss()
            } label: {
                Text("Place pin · \(OnCourseModel.pinSourceTag(spec.source))")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }

    /// The two ways a player thinks about a pin: metres from front + from left,
    /// and (since both are natural) metres from back.
    private func echoLine(_ spec: PinSpec) -> some View {
        let width = frame.width(atDepth: spec.depthFromFrontM)
        let fromLeftM = spec.lateralFraction * width
        let fromBackM = max(0, frame.depthM - spec.depthFromFrontM)
        return VStack(spacing: 2) {
            Text("\(oneDec(spec.depthFromFrontM)) from front · \(oneDec(fromLeftM)) from left")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.primary)
            Text("\(oneDec(fromBackM)) from back")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Parse / resolve

    /// Reset the interpretation state before a fresh capture / submit so stale
    /// candidates or a stale confirm sketch never linger.
    private func resetInterpretations() {
        candidates = []
        selected = nil
        working = nil
        workingClamped = false
        laserNeedsOrigin = false
        attempted = false
    }

    /// Parse a settled utterance (voice or typed) into ranked candidates. One
    /// resolves straight into the confirm sketch; several wait for a tap.
    private func parse(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        attempted = true
        laserNeedsOrigin = false
        selected = nil
        working = nil
        candidates = PinPhraseParser.parse(trimmed, locale: voice.locale)
        if candidates.count == 1 {
            resolve(candidates[0])
        }
    }

    /// Resolve one candidate against the model's frame + origin, seeding the
    /// confirm sketch. The only nil case for a picked candidate is a `.laser`
    /// phrase with no origin to measure from.
    private func resolve(_ phrase: PinPhrase) {
        guard let resolution = model.resolvePinPhrase(phrase) else {
            laserNeedsOrigin = true
            selected = nil
            working = nil
            return
        }
        laserNeedsOrigin = false
        selected = phrase
        working = resolution.spec
        workingClamped = resolution.clamped
    }

    private func dismiss() {
        voice.stop()
        onClose()
    }

    // MARK: - Formatting

    private func oneDec(_ meters: Double) -> String {
        String(format: "%.1f m", meters)
    }

    /// A human-readable line for a candidate row.
    private func describe(_ phrase: PinPhrase) -> String {
        switch phrase {
        case let .sheet(depth, lateralFromLeft):
            return "Sheet · \(oneDec(depth)) from front, \(oneDec(lateralFromLeft)) from left"
        case let .laser(distance, lateralFraction):
            let side = lateralFraction.map(sideWord) ?? "middle"
            return "Laser · \(Int(distance.rounded())) m away, \(side)"
        case let .visual(depthFraction, lateralFraction):
            return "Visual · \(depthWord(depthFraction)), \(sideWord(lateralFraction))"
        case let .hybrid(depth, lateralFraction):
            return "Sheet · \(oneDec(depth)) from front, \(sideWord(lateralFraction))"
        }
    }

    private func sideWord(_ fraction: Double) -> String {
        switch fraction {
        case ..<0.4: return "left side"
        case ..<0.6: return "middle"
        default: return "right side"
        }
    }

    private func depthWord(_ fraction: Double) -> String {
        switch fraction {
        case ..<0.4: return "toward front"
        case ..<0.6: return "middle depth"
        default: return "toward back"
        }
    }
}

// MARK: - Schematic green

/// A top-down schematic of the green drawn from `frame.outlineFrameCoords`
/// (frame coords: x = depth from front, y = lateral metres). Depth points UP the
/// view (back = away from the player, at the top); lateral right = the player's
/// right. The proposed pin is a draggable dot; a drag is converted back to
/// (depthM, lateralFraction) through the inverse of the fit transform and
/// `frame.lateralRange(atDepth:)`, clamped into the green.
private struct GreenSketch: View {
    let frame: GreenFrame
    let spec: PinSpec
    let onMove: (PinSpec) -> Void

    private static let pinColor = Color(red: 1.0, green: 0.83, blue: 0.23)

    var body: some View {
        GeometryReader { geo in
            let layout = Layout(frame: frame, size: geo.size)
            ZStack {
                layout.outlinePath
                    .fill(MapFeature.green.fill.opacity(0.55))
                layout.outlinePath
                    .stroke(MapFeature.green.outline, lineWidth: 2)

                OverlineLabel("BACK", color: .textSecondary, size: 9)
                    .position(x: geo.size.width / 2, y: 12)
                OverlineLabel("FRONT", color: .textSecondary, size: 9)
                    .position(x: geo.size.width / 2, y: geo.size.height - 12)

                Circle()
                    .fill(Self.pinColor)
                    .frame(width: 22, height: 22)
                    .overlay(Circle().strokeBorder(.white, lineWidth: 2))
                    .shadow(radius: 2, y: 1)
                    .position(layout.screenPoint(for: spec))
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        onMove(layout.spec(at: value.location, source: spec.source))
                    }
            )
            .accessibilityElement()
            .accessibilityLabel("Pin position on the green — drag to adjust")
        }
    }

    /// Uniform (aspect-preserving) fit of the green's frame coords into the
    /// view, centred, with a margin for the front/back labels.
    private struct Layout {
        let frame: GreenFrame
        private let minLateral: Double
        private let scale: Double
        private let offX: Double
        private let offY: Double

        init(frame: GreenFrame, size: CGSize) {
            self.frame = frame
            let laterals = frame.outlineFrameCoords.map(\.y)
            let minLat = laterals.min() ?? 0
            let maxLat = laterals.max() ?? 0
            let latSpan = max(maxLat - minLat, 0.1)
            let depthSpan = max(frame.depthM, 0.1)
            let margin: Double = 24
            let availW = max(Double(size.width) - 2 * margin, 1)
            let availH = max(Double(size.height) - 2 * margin, 1)
            let s = min(availW / latSpan, availH / depthSpan)
            self.minLateral = minLat
            self.scale = s
            self.offX = (Double(size.width) - latSpan * s) / 2
            self.offY = (Double(size.height) - depthSpan * s) / 2
        }

        /// Frame coords {x: depth, y: lateral} → screen point. Depth up: front
        /// (depth 0) at the bottom, back (depthM) at the top.
        private func screen(depth: Double, lateral: Double) -> CGPoint {
            CGPoint(
                x: offX + (lateral - minLateral) * scale,
                y: offY + (frame.depthM - depth) * scale
            )
        }

        var outlinePath: Path {
            var path = Path()
            let ring = frame.outlineFrameCoords
            guard let first = ring.first else { return path }
            path.move(to: screen(depth: first.x, lateral: first.y))
            for v in ring.dropFirst() {
                path.addLine(to: screen(depth: v.x, lateral: v.y))
            }
            path.closeSubpath()
            return path
        }

        /// The pin spec's frame coords (lateral fraction → metres via the
        /// cross-section width at that depth) → screen point.
        func screenPoint(for spec: PinSpec) -> CGPoint {
            let depth = min(max(spec.depthFromFrontM, 0), frame.depthM)
            let lateral: Double
            if let range = frame.lateralRange(atDepth: depth) {
                lateral = range.left + spec.lateralFraction * (range.right - range.left)
            } else {
                lateral = 0
            }
            return screen(depth: depth, lateral: lateral)
        }

        /// Inverse of the fit transform: a screen point → (depthM, lateral
        /// fraction), clamped into the green. Depth comes straight from the
        /// vertical axis; the lateral metres are turned back into a fraction of
        /// the cross-section width at that depth (the same mapping
        /// `frame.point(depthM:lateralFraction:)` uses forward), so the dot and
        /// the committed WGS84 pin agree.
        func spec(at point: CGPoint, source: PinSpec.Source) -> PinSpec {
            let depth = min(max(frame.depthM - (Double(point.y) - offY) / scale, 0), frame.depthM)
            let lateral = minLateral + (Double(point.x) - offX) / scale
            let fraction: Double
            if let range = frame.lateralRange(atDepth: depth), range.right > range.left {
                fraction = min(max((lateral - range.left) / (range.right - range.left), 0), 1)
            } else {
                fraction = PinWordFractions.middle
            }
            return PinSpec(depthFromFrontM: depth, lateralFraction: fraction, source: source)
        }
    }
}
