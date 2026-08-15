import Charts
import SwiftUI

/// The elevation-profile sheet: a side cross-section of the terrain along the
/// hole route (tee→green) or the measure path, drawn with Swift Charts. Both
/// axes carry real metre tick labels — numbers, not shading. The y-axis
/// auto-scales to the data (a ±8 m change over 400 m is invisible at 1:1),
/// but the vertical exaggeration is capped so flat holes don't render like
/// cliffs and perceived steepness stays comparable across holes.
///
/// The drawn curve is smoothed with a short moving average (the offline
/// terrain tiles quantize elevation to 0.1 m, which stair-steps at a 2 m
/// sample interval); every printed number (total Δ, per-leg Δ, axis ticks)
/// stays raw.
struct ElevationProfileSheet: View {
    let model: ElevationProfileModel
    let title: String
    let onClose: () -> Void
    @Environment(AppEnvironment.self) private var env

    /// Chart plot size in pixels (for the exaggeration cap), captured from
    /// the chart's plot frame.
    @State private var plotSize: CGSize = .zero

    private static let amber = MeasurePanel.amber

    /// Max (px per vertical metre) / (px per horizontal metre). Matches the
    /// web `MAX_VERTICAL_EXAGGERATION` (elevation-profile.component.ts).
    private static let maxVerticalExaggeration = 10.0

    /// Zoomed visible x-span (m); nil = the whole path (no scrolling). The
    /// y-axis rescales to the visible stretch (same exaggeration cap), so
    /// zooming into part of the hole makes its bumps readable.
    @State private var visibleSpan: Double?
    /// Leading edge (m) of the visible window while zoomed (Charts scroll
    /// position binding).
    @State private var scrollX: Double = 0
    private static let minVisibleSpanMeters = 60.0
    private static let zoomStep = 1.6

    /// X-axis (along-route distance) tick labels only — chart domain/geometry
    /// and the y-axis (elevation) stay metric regardless of this setting (see
    /// `DistanceFormat` doc).
    private var unit: DistanceUnit { env.settings.distanceUnit }

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
            if model.elevationRange != nil {
                zoomControls
            }
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

    /// Zoom in / out / reset (shown once terrain resolved). Zoomed charts
    /// scroll horizontally to reach other stretches of the hole.
    private var zoomControls: some View {
        HStack(spacing: 14) {
            Button { zoom(by: Self.zoomStep) } label: {
                Image(systemName: "minus.magnifyingglass")
            }
            .disabled(visibleSpan == nil)
            .accessibilityLabel("Zoom out")
            Button { zoom(by: 1 / Self.zoomStep) } label: {
                Image(systemName: "plus.magnifyingglass")
            }
            .disabled((visibleSpan ?? .infinity) <= Self.minVisibleSpanMeters)
            .accessibilityLabel("Zoom in")
            if visibleSpan != nil {
                Button {
                    visibleSpan = nil
                    scrollX = 0
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .accessibilityLabel("Reset zoom")
            }
        }
        .font(.system(size: 15))
        .foregroundStyle(.secondary)
        .buttonStyle(.plain)
    }

    /// Adjust the visible x-span by `factor` (>1 out, <1 in), keeping the
    /// window centered where it was.
    private func zoom(by factor: Double) {
        let total = max(model.totalDistance, 1)
        let window = visibleWindow
        let current = window.upperBound - window.lowerBound
        let newSpan = min(total, max(Self.minVisibleSpanMeters, current * factor))
        if newSpan >= total * 0.999 {
            visibleSpan = nil
            scrollX = 0
            return
        }
        let center = (window.lowerBound + window.upperBound) / 2
        scrollX = min(max(center - newSpan / 2, 0), total - newSpan)
        visibleSpan = newSpan
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
        .chartScrollableAxes(visibleSpan == nil ? [] : .horizontal)
        .chartXVisibleDomain(length: visibleSpan ?? max(model.totalDistance, 1))
        .chartScrollPosition(x: $scrollX)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 6)) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let d = value.as(Double.self) {
                        Text(DistanceFormat.stringWithUnit(d, unit: unit)).monospacedDigit()
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
        .onChange(of: model.totalDistance) { _, _ in
            // New path (hole change / measure edit) → back to the overview.
            visibleSpan = nil
            scrollX = 0
        }
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

    /// The x window currently on screen: the whole path, or the zoomed
    /// scroll window.
    private var visibleWindow: ClosedRange<Double> {
        let total = max(model.totalDistance, 1)
        guard let span = visibleSpan, span < total else { return 0...total }
        let lo = min(max(scrollX, 0), total - span)
        return lo...(lo + span)
    }

    /// Y domain from the RAW range of the VISIBLE stretch with a little
    /// headroom, then widened (equally on both sides) until the vertical
    /// exaggeration stays under `maxVerticalExaggeration` for the current
    /// plot frame — zooming in shrinks the visible x-span, which relaxes the
    /// minimum y-span and lets bumps grow. Before the plot frame is known a
    /// typical sheet aspect stands in (the state update re-renders with the
    /// real one a frame later).
    private var yDomain: ClosedRange<Double> {
        guard let range = model.elevationRange else { return 0...1 }
        let window = visibleWindow

        // Raw min/max over the visible samples (full-path range fallback for
        // a window with no coverage).
        var rawLo = Double.infinity
        var rawHi = -Double.infinity
        for sample in model.samples {
            guard let e = sample.elevation, window.contains(sample.distanceMeters) else { continue }
            rawLo = min(rawLo, e)
            rawHi = max(rawHi, e)
        }
        if rawLo > rawHi {
            rawLo = range.min
            rawHi = range.max
        }

        let pad = max(0.5, (rawHi - rawLo) * 0.15)
        var lo = rawLo - pad
        var hi = rawHi + pad
        let aspect = plotSize.width > 0 && plotSize.height > 0
            ? Double(plotSize.height / plotSize.width)
            : 0.45
        let xSpan = window.upperBound - window.lowerBound
        let minSpan = xSpan * aspect / Self.maxVerticalExaggeration
        if hi - lo < minSpan {
            let center = (lo + hi) / 2
            lo = center - minSpan / 2
            hi = center + minSpan / 2
        }
        return lo...hi
    }

    private func yTickText(_ value: Double) -> String {
        let span = yDomain.upperBound - yDomain.lowerBound
        return span < 8
            ? String(format: "%.1f m", value)
            : "\(Int(value.rounded())) m"
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
