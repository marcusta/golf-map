import SwiftUI

/// The full-height vertical distance rail on the left of the on-course map —
/// the Golfshot-style home for the distance ladder (replacing the cramped
/// bottom-card list). Each rung is one target ahead of the ball: a kind-colored
/// tick, a small label, and a big distance. Tapping a rung focuses the map on
/// that feature (pan + cyan highlight) and marks the rung selected.
///
/// Reads `model.ladderRows` (the merged near→far list), presents it far→near so
/// distance increases up the rail, and drives `model.focusMap`. Club advice +
/// the dispersion ellipse on tap land in a follow-up; this owns the layout +
/// selection.
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

    /// Tree-clearance status → accent: clears green, marginal amber, blocked
    /// red, no height data grey.
    static func color(_ status: TreeClearanceStatus) -> Color {
        switch status {
        case .clears: return Color(red: 0.25, green: 0.57, blue: 0.26)
        case .marginal: return Color(red: 0.90, green: 0.63, blue: 0.23)
        case .blocked: return Color(red: 0.86, green: 0.22, blue: 0.20)
        case .unknown: return Color(red: 0.60, green: 0.63, blue: 0.60)
        }
    }

    /// One rail rung: a ladder row, or a tree-clearance crossing on the shot
    /// line (kept outside `LadderRow` so the advice/plays-as machinery keyed on
    /// `LadderRow.Kind` is untouched). Merged near→far by distance from the ball.
    private enum Rung: Identifiable {
        case ladder(OnCourseModel.LadderRow)
        case trees(OnCourseModel.TreeClearanceRow)

        var id: String {
            switch self {
            case .ladder(let row): return row.id
            case .trees(let row): return row.id
            }
        }

        var sortMeters: Int {
            switch self {
            case .ladder(let row): return row.meters
            case .trees(let row): return row.entryM
            }
        }
    }

    private var rungs: [Rung] {
        let merged = model.ladderRows.map(Rung.ladder) + model.treeClearanceRows.map(Rung.trees)
        // Stable near→far merge, presented far→near so distance grows up the rail.
        return merged.enumerated()
            .sorted { $0.element.sortMeters != $1.element.sortMeters
                ? $0.element.sortMeters < $1.element.sortMeters
                : $0.offset < $1.offset }
            .map(\.element)
            .reversed()
    }

    var body: some View {
        let rows = rungs
        if !rows.isEmpty {
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 6) {
                    ForEach(rows) { rung in
                        switch rung {
                        case .ladder(let row): self.rung(row)
                        case .trees(let row): treeRung(row)
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            .frame(width: 120)
            .defaultScrollAnchor(.bottom)
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
        // Layups keep carry as the big number (the near→far sort key = distance
        // from the ball) but earn a second line: the approach club appended to
        // the label — what tells two "Lay up" rungs apart — and the distance
        // still left to the green as the small sub-figure beside the carry.
        let label = row.kind == .layup
            ? row.label + (row.approachClub.map { " · \($0)" } ?? "")
            : row.label
        Button {
            model.inspectBrowseLadder(row)
        } label: {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(accent)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(label)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(selected ? Color.white : accent.opacity(0.9))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        MetricText(DistanceFormat.string(big, unit: unit), size: 22)
                        if row.kind == .hazard, row.carryM != nil {
                            Text(DistanceFormat.string(row.meters, unit: unit))
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        } else if row.kind == .layup, let remaining = row.remainingM {
                            // "235 · 65 in" — carry, then the distance left to the
                            // green after the layup, mirroring the hazard sub-figure.
                            Text(DistanceFormat.string(remaining, unit: unit) + " in")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.black.opacity(selected ? 0.58 : 0.42))
                    .overlay {
                        if selected {
                            RoundedRectangle(cornerRadius: 10)
                                .fill(Self.highlight.opacity(0.12))
                        }
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(
                        selected ? Self.highlight.opacity(0.9) : .clear,
                        lineWidth: 1.5
                    )
            }
        }
        .buttonStyle(.plain)
        .disabled(row.position == nil)
        .accessibilityLabel(accessibilityLabel(row, big: big, label: label))
    }

    /// A tree-clearance rung: "Trees 18 m" over the entry distance, with the
    /// verdict ("clears by 6 m" / "blocked (ball 12 m)" / "height unknown")
    /// as the second line, tinted by status.
    @ViewBuilder private func treeRung(_ row: OnCourseModel.TreeClearanceRow) -> some View {
        let selected = model.focusedLadderId == row.id
        let accent = Self.color(row.status)
        Button {
            if let position = row.position { model.focusMap(on: position, ladderId: row.id) }
        } label: {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(accent)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.label)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(selected ? Color.white : accent.opacity(0.9))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    MetricText(DistanceFormat.string(row.entryM, unit: unit), size: 22)
                    Text(row.detail)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(accent)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.black.opacity(selected ? 0.58 : 0.42))
                    .overlay {
                        if selected {
                            RoundedRectangle(cornerRadius: 10)
                                .fill(Self.highlight.opacity(0.12))
                        }
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(
                        selected ? Self.highlight.opacity(0.9) : .clear,
                        lineWidth: 1.5
                    )
            }
        }
        .buttonStyle(.plain)
        .disabled(row.position == nil)
        .accessibilityLabel("\(row.label), \(row.entryM) meters, \(row.detail)")
    }

    /// Spoken description of a rung. `label` already carries the approach club
    /// for layups; the layup case also voices the remaining distance so a
    /// "Lay up" rung announces the whole outcome ("carry, leaves X to the green")
    /// rather than just its carry.
    private func accessibilityLabel(_ row: OnCourseModel.LadderRow, big: Int, label: String) -> String {
        var base = "\(label), \(big) meters"
        if row.kind == .layup, let remaining = row.remainingM {
            base += ", \(remaining) meters to the green"
        }
        guard row.position != nil else { return base }
        return base + (model.isBrowseMode
            ? ". Tap to inspect from the current browse point."
            : ". Tap to show on map.")
    }

    /// Cyan focus color — matches the map highlight ring.
    private static let highlight = Color(red: 0.13, green: 0.83, blue: 0.93)
}
