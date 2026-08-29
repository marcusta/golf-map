import SwiftUI

/// Pure distance-ladder row builder: the synced fixed targets (hazard
/// crossings + aim points) and the green figures, measured live from the GPS
/// fix and sorted near→far — the watch cousin of the phone's `LadderBuilder`.
/// Targets already passed on the walk to the green are dropped: a target is
/// "ahead" when it sits closer to the green center than the player does.
enum WatchLadder {

    /// Slack on the passed-target filter, meters — a target roughly abeam of
    /// the player still shows.
    static let aheadMarginM = 10.0

    struct Row: Equatable, Identifiable {
        let id: String
        let label: String
        /// Live distance to the target (hazard near edge / aim / green center).
        let metersM: Int
        /// Hazard far edge (the carry); nil elsewhere.
        let carryM: Int?
        /// Green front/back figures on the green row; nil elsewhere.
        let frontM: Int?
        let backM: Int?
        let isHazard: Bool
        let isGreen: Bool
        /// Today's pin row (rendered like the green row, in pin yellow).
        var isPin: Bool = false
    }

    /// `pin` is today's synced pin for this hole, when the phone has sent one —
    /// it adds its own row (the green row keeps measuring to the center).
    static func rows(fix: LatLon, hole: WatchHole, pin: LatLon? = nil) -> [Row] {
        guard let center = hole.greenCenterLatLon else { return [] }
        let toGreenM = Distance.planarMeters(fix, center)
        var rows: [Row] = []

        for (index, target) in (hole.targets ?? []).enumerated() {
            guard let point = target.pointLatLon else { continue }
            guard Distance.planarMeters(point, center) < toGreenM + Self.aheadMarginM
            else { continue }
            let carry = target.farPointLatLon.map {
                Int(Distance.planarMeters(fix, $0).rounded())
            }
            rows.append(Row(
                id: "t-\(index)",
                label: target.label,
                metersM: Int(Distance.planarMeters(fix, point).rounded()),
                carryM: target.kind == "hazard" ? carry : nil,
                frontM: nil, backM: nil,
                isHazard: target.kind == "hazard",
                isGreen: false
            ))
        }

        rows.append(Row(
            id: "green",
            label: "Green",
            metersM: Int(toGreenM.rounded()),
            carryM: nil,
            frontM: hole.greenFrontLatLon.map { Int(Distance.planarMeters(fix, $0).rounded()) },
            backM: hole.greenBackLatLon.map { Int(Distance.planarMeters(fix, $0).rounded()) },
            isHazard: false,
            isGreen: true
        ))

        if let pin {
            rows.append(Row(
                id: "pin",
                label: "Pin",
                metersM: Int(Distance.planarMeters(fix, pin).rounded()),
                carryM: nil,
                frontM: nil, backM: nil,
                isHazard: false,
                isGreen: false,
                isPin: true
            ))
        }

        return rows.sorted { $0.metersM < $1.metersM }
    }
}

/// The distance-ladder page: everything ahead of the player on the current
/// hole, near→far. The crown scrolls the list and pages at its edges.
struct LadderView: View {
    @Bindable var tracker: ShotTracker
    let course: WatchCourseBundle
    /// Today's pins from the phone — adds a Pin rung when the hole has one.
    @Bindable var pins: PinStore
    let selector: HoleSelector

    private var hole: WatchHole? {
        course.holes.indices.contains(selector.currentIndex)
            ? course.holes[selector.currentIndex] : nil
    }

    var body: some View {
        VStack(spacing: 2) {
            header
            content
        }
        .padding(.horizontal, 4)
    }

    private var header: some View {
        HStack {
            if let hole {
                Text("Hole \(hole.number)")
                    .font(.headline)
            }
            Spacer()
            Text("LADDER")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let fix = tracker.currentFix, let hole {
            let origin = LatLon(lat: fix.coordinate.latitude, lon: fix.coordinate.longitude)
            let rows = WatchLadder.rows(
                fix: origin,
                hole: hole,
                pin: pins.pin(courseId: course.courseId, holeNumber: hole.number)
            )
            if rows.isEmpty {
                placeholder("No targets", systemImage: "point.topleft.down.curvedto.point.bottomright.up")
            } else {
                List(rows) { row in
                    rowView(row)
                        .listRowInsets(EdgeInsets(top: 2, leading: 6, bottom: 2, trailing: 6))
                }
                .listStyle(.plain)
            }
        } else {
            placeholder("Acquiring GPS", systemImage: "location")
        }
    }

    private func rowView(_ row: WatchLadder.Row) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(row.label)
                .font(.footnote.weight(row.isGreen || row.isPin ? .semibold : .regular))
                .foregroundStyle(row.isHazard ? .orange : row.isPin ? .yellow : .primary)
                .lineLimit(1)
            Spacer(minLength: 4)
            if row.isGreen, let front = row.frontM, let back = row.backM {
                Text("\(front)–\(back)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Text("\(row.metersM)")
                .font(.body.weight(.semibold))
            if let carry = row.carryM {
                Text("/ \(carry)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .monospacedDigit()
        .contentTransition(.numericText())
    }

    private func placeholder(_ text: String, systemImage: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
