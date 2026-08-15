import SwiftUI

/// The round screen: current hole (auto-followed from GPS, chevrons to
/// override) and the live distance to the green center, plus front/back when
/// the course has them authored.
struct OnCourseView: View {
    @Bindable var tracker: ShotTracker
    let course: WatchCourseBundle
    /// Owned by `CoursePagesView` (shared with the green-map page); GPS
    /// updates feed it there — this view only reads it and moves it via the
    /// chevrons.
    @Binding var selector: HoleSelector
    let onSwitchCourse: () -> Void
    let courseCount: Int

    private var hole: WatchHole? {
        course.holes.indices.contains(selector.currentIndex)
            ? course.holes[selector.currentIndex] : nil
    }

    var body: some View {
        VStack(spacing: 6) {
            header
            Spacer(minLength: 0)
            distanceReadout
            Spacer(minLength: 0)
            holeNavigation
        }
        .padding(.horizontal, 4)
    }

    private var header: some View {
        HStack {
            if let hole {
                Text("Hole \(hole.number)")
                    .font(.headline)
                Text("Par \(hole.par)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if courseCount > 1 {
                Button(action: onSwitchCourse) {
                    Image(systemName: "list.bullet")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var distanceReadout: some View {
        if let fix = tracker.currentFix, let hole, let center = hole.greenCenterLatLon {
            let origin = LatLon(lat: fix.coordinate.latitude, lon: fix.coordinate.longitude)
            let centerM = Distance.planarMeters(origin, center)
            VStack(spacing: 2) {
                (Text("\(Int(centerM.rounded()))")
                    .font(.system(size: 50, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                 + Text(" m")
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.secondary))
                    .contentTransition(.numericText())
                playsLikeRow(from: origin, hole: hole)
                frontBackRow(from: origin, hole: hole)
            }
        } else {
            VStack(spacing: 4) {
                Text("—")
                    .font(.system(size: 50, weight: .semibold, design: .rounded))
                Label("Acquiring GPS", systemImage: "location")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Elevation-adjusted "plays like" to the green center, from the synced
    /// elevation grids (player elevation off the corridor/green tier, green
    /// elevation off the fine tier). Hidden whenever either sample is
    /// unavailable — straight distance is never wrong, plays-like can be.
    @ViewBuilder
    private func playsLikeRow(from origin: LatLon, hole: WatchHole) -> some View {
        if let center = hole.greenCenterLatLon {
            let p = Sweref99TM.fromWGS84(origin)
            let c = Sweref99TM.fromWGS84(center)
            if let playerElevation = hole.elevation(atE: p.x, n: p.y),
               let greenElevation = hole.greenGrid?.elevation(atE: c.x, n: c.y) {
                let stats = PlaysLike.segmentStats(
                    PlaysLike.Point(e: p.x, n: p.y, elevation: playerElevation),
                    PlaysLike.Point(e: c.x, n: c.y, elevation: greenElevation)
                )
                if let plays = stats.playsLikeSimple, let delta = stats.elevationDelta {
                    HStack(spacing: 3) {
                        Image(systemName: delta >= 0.5 ? "arrow.up.right"
                            : delta <= -0.5 ? "arrow.down.right" : "arrow.right")
                        Text("Plays \(Int(plays.rounded()))")
                            .monospacedDigit()
                            .contentTransition(.numericText())
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.primary)
                }
            }
        }
    }

    @ViewBuilder
    private func frontBackRow(from origin: LatLon, hole: WatchHole) -> some View {
        if let front = hole.greenFrontLatLon, let back = hole.greenBackLatLon {
            HStack(spacing: 12) {
                Text("F \(Int(Distance.planarMeters(origin, front).rounded()))")
                Text("B \(Int(Distance.planarMeters(origin, back).rounded()))")
            }
            .font(.footnote.weight(.medium))
            .monospacedDigit()
            .foregroundStyle(.secondary)
        }
    }

    private var holeNavigation: some View {
        HStack {
            Button {
                selector.select(index: selector.currentIndex - 1, holeCount: course.holes.count)
            } label: {
                Image(systemName: "chevron.left")
            }
            .disabled(selector.currentIndex == 0)

            Spacer()
            // AUTO shows while GPS drives the hole; a manual override shows
            // the release rule instead (stepping onto a tee re-locks).
            Text(selector.isManual ? "MANUAL" : "AUTO")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(selector.isManual ? .orange : .secondary)
            Spacer()

            Button {
                selector.select(index: selector.currentIndex + 1, holeCount: course.holes.count)
            } label: {
                Image(systemName: "chevron.right")
            }
            .disabled(selector.currentIndex >= course.holes.count - 1)
        }
        .font(.footnote)
        .buttonStyle(.bordered)
    }
}
