import SwiftUI

/// Bottom control panel for the on-course Green view — now just the putt-read
/// section (`PuttReadSection`, doc feature-putting-green-reading §5.1) with the
/// green view's (i) and close controls folded into its header row. Styled like
/// the on-course distance card (dark material over the map).
///
/// The panel covers the map, so it is as short as it can be: the mode selector
/// (Slope/Height/Relative), the Ball/Hole placement chips, and the caddy-advice
/// bulb live on the map control rail (CourseScreen); the legend is a strip
/// pinned to the map's left edge (`GreenLegendStrip`); the reference numbers
/// and the rarely-touched settings (surrounds buffer, stimp, quiz) stay behind
/// the (i) button.
struct GreenViewPanel: View {
    let model: GreenAnalysisModel
    let putt: PuttReadModel
    /// Putt-read training quiz (doc §5.1) — headless state, hosted by
    /// `PuttReadSection`.
    let quiz: PuttQuizModel
    /// API client for the quiz's fire-and-forget scored-sample POST.
    let client: GolfAPIClient
    /// The active hole's green id, or nil (Tier-3 manual, no surface) — the
    /// quiz attaches it to the recorded sample.
    let greenId: String?
    /// Present the spot-level capture sheet (owned by the screen).
    let onLevel: () -> Void
    /// Present the LiDAR corridor-scan flow (task E1); nil = unsupported
    /// hardware, the affordance is hidden.
    var onScan: (() -> Void)?
    let onClose: () -> Void

    /// The (i) popover: stats + the surrounds/stimp settings. `-greenInfo 1`
    /// opens it on launch so the headless live-verify pass can screenshot it
    /// (a tap isn't scriptable through simctl).
    @State private var showInfo = {
        #if DEBUG
        return UserDefaults.standard.string(forKey: "greenInfo") == "1"
        #else
        return false
        #endif
    }()

    var body: some View {
        VStack(spacing: 8) {
            if model.isLoading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Sampling terrain…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if let errorText = model.errorText {
                Text(errorText)
                    .font(.footnote)
                    .foregroundStyle(Color.statusNegative)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            PuttReadSection(
                model: putt,
                quiz: quiz,
                client: client,
                greenId: greenId,
                surfaceLoading: model.isLoading,
                onLevel: onLevel,
                onScan: onScan,
                trailing: { headerControls }
            )
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s3)
        .padding(.bottom, Space.s3)
        .glassPanel()
    }

    /// The green view's (i) + close, appended to the putt header row — the
    /// panel has no title row of its own.
    private var headerControls: some View {
        HStack(spacing: 8) {
            Button { showInfo = true } label: {
                Image(systemName: "info.circle")
                    .font(.system(size: 18))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Green details and settings")
            .accessibilityIdentifier("green-view-info")
            .popover(isPresented: $showInfo) {
                infoPopover
                    .presentationCompactAdaptation(.popover)
                    // A popover is its own window — it inherits neither the
                    // screen's forced-dark chrome nor an opaque backdrop, and
                    // over the slope overlay a translucent one is unreadable.
                    // The backdrop is resolved in the PRESENTATION environment,
                    // which is light, so a dynamic token would come back white
                    // under the (dark-scheme) white text — hence the literal.
                    .environment(\.colorScheme, .dark)
                    .presentationBackground(Color(hex: "#2C2519"))
            }
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close green view")
        }
    }

    // MARK: - Info popover (stats + settings)

    /// Everything that was pushed off the card: the green/surrounds reference
    /// numbers and the two sliders you set once and forget (surrounds buffer,
    /// stimp). Off the map, so the panel over the green stays short.
    private var infoPopover: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let stats = model.result?.stats {
                statsGrid(stats)
            } else if model.isLoading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Sampling terrain…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text(model.errorText ?? "No terrain data for this green.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Divider()
            bufferRow
            stimpRow
            quizToggle
        }
        .padding(14)
        .frame(width: 300)
    }

    /// Putt-read training quiz (doc §5.1) — estimate the read before it is
    /// revealed. A setting you flip between rounds, not per putt, and it is
    /// advice-adjacent, so it is hidden in competition mode like the read
    /// itself.
    @ViewBuilder
    private var quizToggle: some View {
        if putt.display.status != .competition {
            Toggle("Quiz — estimate first", isOn: Binding(
                get: { quiz.enabled },
                set: { quiz.enabled = $0 }
            ))
            .toggleStyle(.switch)
            .font(.caption)
            .accessibilityIdentifier("putt-quiz-toggle")
        }
    }

    /// Green speed — drives the putt read's pace/break (`PuttReadModel`).
    private var stimpRow: some View {
        HStack(spacing: 8) {
            Text("Stimp")
                .font(.caption)
                .foregroundStyle(.secondary)
            Slider(
                value: Binding(
                    get: { putt.stimpFt },
                    set: { putt.setStimp(($0 * 2).rounded() / 2) }
                ),
                in: PuttReadModel.stimpMinFt...PuttReadModel.stimpMaxFt
            )
            MetricText(String(format: "%.1f", putt.stimpFt), size: 12)
                .frame(width: 32, alignment: .trailing)
        }
    }

    // MARK: - Stats

    private func statsGrid(_ stats: AnalysisStats) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                OverlineLabel("Green", size: 10)
                statRow("Elev", String(
                    format: "%.1f–%.1f", stats.green.minHeight, stats.green.maxHeight
                ), unit: "m")
                statRow("Δ height", String(format: "%.2f", stats.green.deltaHeight), unit: "m")
                statRow("Max slope", String(format: "%.1f", stats.green.maxSlopePct), unit: "%")
                statRow("Avg slope", String(format: "%.1f", stats.green.avgSlopePct), unit: "%")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                OverlineLabel("Surrounds", size: 10)
                statRow("Max slope", String(format: "%.1f", stats.surrounds.maxSlopePct), unit: "%")
                if stats.surrounds.deepestHollowM > 0.05 {
                    statRow(
                        "Hollow",
                        String(format: "%.2f", stats.surrounds.deepestHollowM),
                        unit: "m below"
                    )
                } else {
                    statRow("Hollow", "none")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func statRow(_ label: String, _ value: String, unit: String? = nil) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 6)
            MetricText(value, unit: unit, size: 12)
        }
    }

    // MARK: - Buffer

    private var bufferRow: some View {
        HStack(spacing: 8) {
            Text("Surrounds")
                .font(.caption)
                .foregroundStyle(.secondary)
            Slider(
                value: Binding(
                    get: { model.bufferM },
                    set: { model.setBuffer(($0 / 5).rounded() * 5) }
                ),
                in: AnalysisGridMath.bufferMinM...AnalysisGridMath.bufferMaxM
            )
            MetricText("\(Int(model.bufferM))", unit: "m", size: 12)
                .frame(width: 44, alignment: .trailing)
        }
    }
}

// MARK: - Legend strip (pinned to the map, not the panel)

/// The active ramp as a thin vertical gradient strip with endpoint labels,
/// pinned to the map's left edge while the Green view is up. Lives with the
/// overlay it explains, so the bottom panel stays short. Same stops as the
/// overlay colors — both come from AnalysisMath.
struct GreenLegendStrip: View {
    let model: GreenAnalysisModel

    var body: some View {
        VStack(spacing: 4) {
            legendLabel(topLabel)
            LinearGradient(stops: stops, startPoint: .bottom, endPoint: .top)
                .frame(width: 10)
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(.black.opacity(0.3), lineWidth: 0.5))
            legendLabel(bottomLabel)
        }
        .frame(width: 44)
        .allowsHitTesting(false)
    }

    private func legendLabel(_ text: String) -> some View {
        Text(text)
            .font(AppFont.mono(9, .semibold))
            .foregroundStyle(Overlay.text)
            .lineLimit(1)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Overlay.readoutFill, in: Capsule())
    }

    private var topLabel: String {
        switch model.mode {
        case .slope: return "7%+"
        case .height: return "High"
        case .relative:
            let scale = model.result?.stats.relScaleM
            return scale.map { String(format: "+%.1f m", $0) } ?? "+"
        case .curvature: return "Ridge"
        }
    }

    private var bottomLabel: String {
        switch model.mode {
        case .slope: return "0%"
        case .height: return "Low"
        case .relative:
            let scale = model.result?.stats.relScaleM
            return scale.map { String(format: "−%.1f m", $0) } ?? "−"
        case .curvature: return "Hollow"
        }
    }

    private var stops: [Gradient.Stop] {
        func color(_ c: AnalysisRGB) -> Color {
            Color(red: Double(c.r) / 255, green: Double(c.g) / 255, blue: Double(c.b) / 255)
        }
        switch model.mode {
        case .slope:
            // Stops proportional to the 0–7%+ scale (thresholds at 1/3/5/7).
            return [
                .init(color: color(SLOPE_BLUE), location: 0),
                .init(color: color(SLOPE_BLUE), location: 1 / 7),
                .init(color: color(SLOPE_GREEN), location: 3 / 7),
                .init(color: color(SLOPE_ORANGE), location: 5 / 7),
                .init(color: color(SLOPE_MAGENTA), location: 1),
            ]
        case .height:
            return HEIGHT_STOPS.enumerated().map { index, stop in
                .init(color: color(stop), location: Double(index) / Double(HEIGHT_STOPS.count - 1))
            }
        case .relative, .curvature:
            // Deepest hollow (purple) → neutral → highest mound / ridge (red).
            let stops = REL_BELOW_STOPS.reversed() + REL_ABOVE_STOPS.dropFirst()
            let count = stops.count
            return stops.enumerated().map { index, stop in
                .init(color: color(stop), location: Double(index) / Double(count - 1))
            }
        }
    }
}
