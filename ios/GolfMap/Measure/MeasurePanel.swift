import SwiftUI

/// Bottom readout card while the MEASURE tool is active (replaces the
/// distance card): prominent totals row (Horizontal / Elev Δ signed / Slope %
/// / Plays-like) + a horizontally scrolling per-segment strip, with Undo /
/// Clear / Profile controls in the header. Compact port of the web
/// measure-panel readout, styled like the on-course distance card.
struct MeasurePanel: View {
    let model: MeasureModel
    /// Toggle the elevation-profile sheet (reads the measure path while
    /// measuring).
    let onProfile: () -> Void
    /// Exit measure mode.
    let onClose: () -> Void
    @Environment(AppEnvironment.self) private var env

    /// Measure amber (web COLOR_LINE #fbbf24).
    static let amber = Color(red: 0.98, green: 0.75, blue: 0.14)

    /// Elev Δ and Slope % deliberately stay metric/percent regardless of this
    /// setting — golf convention, not a "distance" for unit-conversion
    /// purposes (see `DistanceFormat` doc).
    private var unit: DistanceUnit { env.settings.distanceUnit }

    var body: some View {
        VStack(spacing: 8) {
            header
            if model.hasPath {
                totalsRow
                if model.segments.count > 1 {
                    segmentStrip
                }
            } else {
                Text(model.points.isEmpty
                    ? "Tap the map to place point A"
                    : "Tap again to place point B")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s3)
        .padding(.bottom, Space.s3)
        .glassPanel()
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Label("Measure", systemImage: "ruler")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Self.amber)
            MetricText("\(model.points.count)", unit: "pt", size: 11, weight: .regular,
                       color: .secondary)
            Spacer()
            headerButton("arrow.uturn.backward", label: "Undo last point") {
                model.undoLast()
            }
            .disabled(model.points.isEmpty)
            .opacity(model.points.isEmpty ? 0.35 : 1)
            headerButton("trash", label: "Clear measurement") {
                model.clear()
            }
            .disabled(model.points.isEmpty)
            .opacity(model.points.isEmpty ? 0.35 : 1)
            headerButton("chart.xyaxis.line", label: "Elevation profile", action: onProfile)
                .disabled(!model.hasPath)
                .opacity(model.hasPath ? 1 : 0.35)
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Exit measure")
        }
    }

    private func headerButton(
        _ systemImage: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 30, height: 30)
                .background(.white.opacity(0.08), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: - Totals

    private var totalsRow: some View {
        let totals = model.totals
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            totalValue(
                label: "Horizontal",
                value: DistanceFormat.string(totals.horizontal, unit: unit),
                unit: unit.abbreviation,
                emphasized: true
            )
            totalValue(
                label: "Elev Δ",
                value: totals.elevationDelta.map { Self.signedMeters($0, unit: false) },
                unit: "m"
            )
            totalValue(
                label: "Slope",
                value: totals.slopePct.map { String(format: "%.1f", $0) },
                unit: "%"
            )
            totalValue(
                label: "Plays-like",
                value: totals.playsLikeSimple.map { DistanceFormat.string($0, unit: unit) },
                unit: unit.abbreviation
            )
        }
    }

    /// Big mono readout on the metric ramp; nil value renders "–" without a
    /// dangling unit (missing elevation coverage).
    private func totalValue(
        label: String, value: String?, unit: String, emphasized: Bool = false
    ) -> some View {
        VStack(spacing: 2) {
            MetricText(value ?? "–", unit: value == nil ? nil : unit,
                       size: emphasized ? 30 : 20)
                .minimumScaleFactor(0.55)
            OverlineLabel(label, color: emphasized ? Self.amber : .secondary, size: 10)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Per-segment strip

    private var segmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(model.segments.enumerated()), id: \.offset) { index, segment in
                    HStack(spacing: 4) {
                        Text(MeasureModel.segmentLabel(index))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        MetricText(DistanceFormat.string(segment.horizontal, unit: unit), unit: unit.abbreviation, size: 12)
                        MetricText(
                            "Δ \(Self.signedMeters(segment.elevationDelta, decimals: 1, unit: false))",
                            size: 11, weight: .regular, color: .secondary
                        )
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(.white.opacity(0.08), in: Capsule())
                }
            }
        }
    }

    // MARK: - Formatting

    /// Whole meters with unit; "–" for nil (missing elevation coverage).
    static func meters(_ value: Double?) -> String {
        guard let value else { return "–" }
        return "\(Int(value.rounded())) m"
    }

    /// Signed meters, one decimal ("+8.2 m" / "−3.4 m"); "–" for nil.
    static func signedMeters(_ value: Double?, decimals: Int = 1, unit: Bool = true) -> String {
        guard let value else { return "–" }
        let sign = value >= 0 ? "+" : "−"
        let body = String(format: "%.\(decimals)f", abs(value))
        return unit ? "\(sign)\(body) m" : "\(sign)\(body)"
    }

    /// Slope percent, one decimal; "–" for nil.
    static func percent(_ value: Double?) -> String {
        guard let value else { return "–" }
        return String(format: "%.1f %%", value)
    }
}
