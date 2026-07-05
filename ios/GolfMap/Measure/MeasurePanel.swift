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

    /// Measure amber (web COLOR_LINE #fbbf24).
    static let amber = Color(red: 0.98, green: 0.75, blue: 0.14)

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
        .padding(.horizontal, 14)
        .padding(.top, 9)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial.opacity(0.88), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Label("Measure", systemImage: "ruler")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Self.amber)
            Text("\(model.points.count) pt")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .monospacedDigit()
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
                label: "HORIZONTAL",
                value: Self.meters(totals.horizontal),
                emphasized: true
            )
            totalValue(label: "ELEV Δ", value: Self.signedMeters(totals.elevationDelta))
            totalValue(label: "SLOPE", value: Self.percent(totals.slopePct))
            totalValue(label: "PLAYS-LIKE", value: Self.meters(totals.playsLikeSimple))
        }
    }

    private func totalValue(label: String, value: String, emphasized: Bool = false) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: emphasized ? 28 : 21, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.55)
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(emphasized ? Self.amber : Color.secondary)
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
                        Text(Self.meters(segment.horizontal))
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                        Text("Δ \(Self.signedMeters(segment.elevationDelta, decimals: 1, unit: false))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
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
