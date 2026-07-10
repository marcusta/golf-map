import SwiftUI

/// Bottom control panel for the on-course Green view: Slope/Height/Relative
/// segmented toggle, the active ramp's legend, green + surrounds stats, the
/// surrounds-buffer slider, and the putt-read section (`PuttReadSection`,
/// doc feature-putting-green-reading §5.1). Compact port of the web editor's
/// analysis side panel (analysis-panel.component.ts) styled like the
/// on-course distance card (dark material over the map).
struct GreenViewPanel: View {
    let model: GreenAnalysisModel
    let putt: PuttReadModel
    /// Present the spot-level capture sheet (owned by the screen).
    let onLevel: () -> Void
    /// Present the LiDAR corridor-scan flow (task E1); nil = unsupported
    /// hardware, the affordance is hidden.
    var onScan: (() -> Void)?
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            header
            modePicker
            legend
            if let stats = model.result?.stats {
                statsGrid(stats)
            } else if model.isLoading {
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
            bufferRow
            Divider()
                .overlay(.white.opacity(0.15))
            PuttReadSection(
                model: putt,
                surfaceLoading: model.isLoading,
                onLevel: onLevel,
                onScan: onScan
            )
        }
        .padding(.horizontal, 14)
        .padding(.top, 9)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial.opacity(0.88), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var header: some View {
        HStack {
            Label("Green view", systemImage: "flag.circle.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.green)
            Spacer()
            Text(modeHint)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close green view")
        }
    }

    private var modeHint: String {
        switch model.mode {
        case .slope: return "Slope % + fall lines"
        case .height: return "Elevation on this green"
        case .relative: return "Hollows read blue/purple"
        }
    }

    private var modePicker: some View {
        Picker("Overlay", selection: Binding(
            get: { model.mode },
            set: { model.setMode($0) }
        )) {
            Text("Slope").tag(AnalysisMode.slope)
            Text("Height").tag(AnalysisMode.height)
            Text("Relative").tag(AnalysisMode.relative)
        }
        .pickerStyle(.segmented)
    }

    // MARK: - Legend

    /// The active ramp as a gradient bar + endpoint labels (same stops as the
    /// overlay colors — both come from AnalysisMath).
    private var legend: some View {
        VStack(spacing: 2) {
            LinearGradient(
                stops: legendStops,
                startPoint: .leading,
                endPoint: .trailing
            )
            .frame(height: 8)
            .clipShape(RoundedRectangle(cornerRadius: 3))
            .overlay(
                RoundedRectangle(cornerRadius: 3)
                    .strokeBorder(.black.opacity(0.3), lineWidth: 0.5)
            )
            HStack {
                ForEach(Array(legendLabels.enumerated()), id: \.offset) { index, label in
                    if index > 0 { Spacer() }
                    Text(label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        }
    }

    private var legendStops: [Gradient.Stop] {
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
        case .relative:
            // Deepest hollow (purple) → green level (neutral) → highest mound (red).
            let stops = REL_BELOW_STOPS.reversed() + REL_ABOVE_STOPS.dropFirst()
            let count = stops.count
            return stops.enumerated().map { index, stop in
                .init(color: color(stop), location: Double(index) / Double(count - 1))
            }
        }
    }

    private var legendLabels: [String] {
        switch model.mode {
        case .slope:
            return ["0%", "1%", "3%", "5%", "7%+"]
        case .height:
            return ["Low", "High"]
        case .relative:
            let scale = model.result?.stats.relScaleM
            let label = scale.map { String(format: "%.1f m", $0) } ?? ""
            return ["−\(label)", "green level", "+\(label)"]
        }
    }

    // MARK: - Stats

    private func statsGrid(_ stats: AnalysisStats) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                sectionTitle("Green")
                statRow("Elev", String(
                    format: "%.1f–%.1f m", stats.green.minHeight, stats.green.maxHeight
                ))
                statRow("Δ height", String(format: "%.2f m", stats.green.deltaHeight))
                statRow("Max slope", String(format: "%.1f %%", stats.green.maxSlopePct))
                statRow("Avg slope", String(format: "%.1f %%", stats.green.avgSlopePct))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                sectionTitle("Surrounds")
                statRow("Max slope", String(format: "%.1f %%", stats.surrounds.maxSlopePct))
                statRow(
                    "Hollow",
                    stats.surrounds.deepestHollowM > 0.05
                        ? String(format: "%.2f m below", stats.surrounds.deepestHollowM)
                        : "none"
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .kerning(0.6)
    }

    private func statRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 6)
            Text(value)
                .font(.caption.weight(.semibold))
                .monospacedDigit()
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
            Text("\(Int(model.bufferM)) m")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .frame(width: 36, alignment: .trailing)
        }
    }
}
