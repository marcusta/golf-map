import Charts
import SwiftUI

/// The elevation-profile sheet: a side cross-section of the terrain along the
/// hole route (tee→green) or the measure path, drawn with Swift Charts. Both
/// axes carry real metre tick labels — numbers, not shading. The y-axis
/// auto-scales to fill the chart (a ±8 m change over 400 m is invisible at
/// 1:1), and the resulting vertical exaggeration is computed from the actual
/// pixel/metre ratios and printed as an honest caption.
///
/// The drawn curve is smoothed with a short moving average (the offline
/// terrain tiles quantize elevation to 0.1 m, which stair-steps at a 2 m
/// sample interval); every printed number (total Δ, per-leg Δ, axis ticks)
/// stays raw.
struct ElevationProfileSheet: View {
    let model: ElevationProfileModel
    let title: String
    let onClose: () -> Void

    /// Chart plot size in pixels (for the exaggeration caption), captured
    /// from the chart's plot frame.
    @State private var plotSize: CGSize = .zero

    private static let amber = MeasurePanel.amber

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if model.isLoading && model.samples.isEmpty {
                loadingView
            } else if elevationRuns.isEmpty {
                emptyView
            } else {
                statsRow
                chart
                caption
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .environment(\.colorScheme, .dark)
        .presentationDetents([.height(300), .medium])
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        .presentationDragIndicator(.visible)
        .presentationBackground(.thinMaterial)
    }

    // MARK: - Header + stats

    private var header: some View {
        HStack {
            Label(title, systemImage: "chart.xyaxis.line")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Self.amber)
                .lineLimit(1)
            if model.isLoading {
                ProgressView().controlSize(.small)
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close elevation profile")
        }
    }

    /// Total Δ (last − first vertex, e.g. green − tee) + per-leg Δ chips.
    private var statsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Text(totalDeltaLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(MeasurePanel.signedMeters(model.totalDelta))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Self.amber)
                        .monospacedDigit()
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(.white.opacity(0.12), in: Capsule())

                ForEach(Array(model.legDeltas.enumerated()), id: \.offset) { _, leg in
                    HStack(spacing: 4) {
                        Text(leg.label)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text("Δ \(MeasurePanel.signedMeters(leg.delta, unit: false))")
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(.white.opacity(0.08), in: Capsule())
                }
            }
        }
    }

    private var totalDeltaLabel: String {
        guard let first = model.markers.first, let last = model.markers.last,
              first.label != last.label
        else { return "Total Δ" }
        return "Δ \(last.label)−\(first.label)"
    }

    // MARK: - Chart

    private var chart: some View {
        Chart {
            ForEach(elevationRuns.indices, id: \.self) { runIndex in
                ForEach(elevationRuns[runIndex], id: \.distanceMeters) { sample in
                    AreaMark(
                        x: .value("Distance", sample.distanceMeters),
                        yStart: .value("Base", yDomain.lowerBound),
                        yEnd: .value("Elevation", sample.elevation ?? yDomain.lowerBound),
                        series: .value("Run", runIndex)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Self.amber.opacity(0.35), Self.amber.opacity(0.05)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    LineMark(
                        x: .value("Distance", sample.distanceMeters),
                        y: .value("Elevation", sample.elevation ?? yDomain.lowerBound),
                        series: .value("Run", runIndex)
                    )
                    .foregroundStyle(Self.amber)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                }
            }

            // Labelled verticals at tee / aims / green (or A, B, C…), with the
            // RAW vertex elevation dot when it resolved.
            ForEach(Array(model.markers.enumerated()), id: \.offset) { _, marker in
                RuleMark(x: .value("Distance", marker.distanceMeters))
                    .foregroundStyle(.white.opacity(0.25))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .annotation(position: .top, alignment: .center) {
                        Text(marker.label)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                if let elevation = marker.elevation {
                    PointMark(
                        x: .value("Distance", marker.distanceMeters),
                        y: .value("Elevation", elevation)
                    )
                    .symbolSize(36)
                    .foregroundStyle(.white)
                }
            }
        }
        .chartXScale(domain: 0...max(model.totalDistance, 1))
        .chartYScale(domain: yDomain)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 6)) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let d = value.as(Double.self) {
                        Text("\(Int(d.rounded())) m").monospacedDigit()
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 5)) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let d = value.as(Double.self) {
                        Text(yTickText(d)).monospacedDigit()
                    }
                }
            }
        }
        .chartBackground { proxy in
            GeometryReader { geo in
                let size = proxy.plotFrame.map { geo[$0].size } ?? .zero
                Color.clear
                    .onAppear { plotSize = size }
                    .onChange(of: size) { _, newSize in plotSize = newSize }
            }
        }
        .frame(minHeight: 120)
    }

    /// Contiguous runs of non-nil SMOOTHED samples (nil coverage → visible
    /// gap between runs).
    private var elevationRuns: [[ElevationProfile.Sample]] {
        let smoothed = ElevationProfile.smoothed(model.samples)
        var runs: [[ElevationProfile.Sample]] = []
        var current: [ElevationProfile.Sample] = []
        for sample in smoothed {
            if sample.elevation != nil {
                current.append(sample)
            } else if !current.isEmpty {
                runs.append(current)
                current = []
            }
        }
        if !current.isEmpty { runs.append(current) }
        return runs
    }

    /// Y domain from the RAW range with a little headroom; the auto-fill of
    /// the plot height is what produces the vertical exaggeration.
    private var yDomain: ClosedRange<Double> {
        guard let range = model.elevationRange else { return 0...1 }
        let pad = max(0.5, (range.max - range.min) * 0.15)
        return (range.min - pad)...(range.max + pad)
    }

    private func yTickText(_ value: Double) -> String {
        let span = yDomain.upperBound - yDomain.lowerBound
        return span < 8
            ? String(format: "%.1f m", value)
            : "\(Int(value.rounded())) m"
    }

    // MARK: - Caption (honest scale note)

    private var caption: some View {
        Text(captionText)
            .font(.caption2)
            .foregroundStyle(.secondary)
    }

    private var captionText: String {
        var parts: [String] = []
        if let factor = verticalExaggeration {
            parts.append(String(format: "Vertical exaggeration ~%.0f×", factor))
        }
        parts.append("terrain sampled every 2 m (0.1 m steps), curve smoothed ~10 m; Δ values are raw")
        return parts.joined(separator: " · ")
    }

    /// (px per vertical metre) / (px per horizontal metre), from the actual
    /// plot frame — an honest number, not a guess.
    private var verticalExaggeration: Double? {
        let xSpan = max(model.totalDistance, 1)
        let ySpan = yDomain.upperBound - yDomain.lowerBound
        guard plotSize.width > 0, plotSize.height > 0, ySpan > 0 else { return nil }
        let pxPerMeterY = Double(plotSize.height) / ySpan
        let pxPerMeterX = Double(plotSize.width) / xSpan
        guard pxPerMeterX > 0 else { return nil }
        return pxPerMeterY / pxPerMeterX
    }

    // MARK: - Empty / loading

    private var loadingView: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text("Sampling terrain…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 120)
    }

    private var emptyView: some View {
        Text(model.path.count < 2
            ? "No route on this hole to profile."
            : "No terrain data along this line.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 120)
    }
}
