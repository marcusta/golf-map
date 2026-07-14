import SwiftUI

/// The full-height vertical distance rail on the left of the on-course map —
/// the Golfshot-style home for the distance ladder (replacing the cramped
/// bottom-card list). Each rung is one target ahead of the ball: a kind-colored
/// tick, a small label, and a big distance. Tapping a rung focuses the map on
/// that feature (pan + cyan highlight) and marks the rung selected.
///
/// Reads `model.ladderRows` (the merged near→far list) and drives
/// `model.focusMap`. Club advice + the dispersion ellipse on tap land in a
/// follow-up; this owns the layout + selection.
struct LadderRailView: View {
    let model: OnCourseModel
    @Environment(AppEnvironment.self) private var env

    private var unit: DistanceUnit { env.settings.distanceUnit }

    /// Kind → accent (dot/tick + label). Mirrors the map overlay palette.
    static func color(_ kind: OnCourseModel.LadderRow.Kind) -> Color {
        switch kind {
        case .plan: return Color(red: 0.655, green: 0.545, blue: 0.98)  // plan violet
        case .hazard: return Color(red: 0.90, green: 0.63, blue: 0.23)  // amber
        case .aim: return Color(red: 0.60, green: 0.63, blue: 0.60)     // gray
        case .layup: return Color(red: 0.25, green: 0.57, blue: 0.26)   // green
        case .green: return Color(red: 0.08, green: 0.72, blue: 0.65)   // teal
        case .pin: return Color(red: 1.0, green: 0.83, blue: 0.23)      // gold
        }
    }

    var body: some View {
        let rows = model.ladderRows
        if !rows.isEmpty {
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 6) {
                    ForEach(rows) { row in
                        rung(row)
                    }
                }
                .padding(.vertical, 2)
            }
            .frame(width: 112)
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    @ViewBuilder private func rung(_ row: OnCourseModel.LadderRow) -> some View {
        let selected = model.focusedLadderId == row.id
        let accent = Self.color(row.kind)
        // Hazards read as "clear the carry": the carry (far edge) is the big
        // number, the near edge a small sub-figure. Everything else is a single
        // distance from the ball.
        let big = row.carryM ?? row.meters
        Button {
            if let position = row.position {
                model.focusMap(on: position, ladderId: row.id)
            }
        } label: {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(accent)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.label)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(selected ? accent : accent.opacity(0.9))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        MetricText(DistanceFormat.string(big, unit: unit), size: 22)
                        if row.kind == .hazard, row.carryM != nil {
                            Text(DistanceFormat.string(row.meters, unit: unit))
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "scope")
                        .font(.system(size: 10))
                        .foregroundStyle(Self.highlight)
                }
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                (selected ? Self.highlight.opacity(0.16) : Color.black.opacity(0.42)),
                in: RoundedRectangle(cornerRadius: 10)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(selected ? Self.highlight.opacity(0.6) : .clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(row.position == nil)
        .accessibilityLabel("\(row.label), \(big) meters" + (row.position != nil ? ". Tap to show on map." : ""))
    }

    /// Cyan focus color — matches the map highlight ring.
    private static let highlight = Color(red: 0.13, green: 0.83, blue: 0.93)
}
