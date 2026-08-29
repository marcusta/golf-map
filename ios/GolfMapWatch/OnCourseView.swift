import SwiftUI

/// The round screen: current hole (auto-followed from GPS, swipe left/right
/// to override) and the live distance to the green center, plus front/back
/// when the course has them authored.
struct OnCourseView: View {
    @Bindable var tracker: ShotTracker
    let course: WatchCourseBundle
    /// Today's pins from the phone. When the current hole has one it becomes
    /// the headline number (the green center drops into the F/C/B row).
    @Bindable var pins: PinStore
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

    /// Today's pin for the hole on screen, if the phone has synced one.
    private var pin: LatLon? {
        guard let hole else { return nil }
        return pins.pin(courseId: course.courseId, holeNumber: hole.number)
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
            // The headline is the pin when today's pin is known, else the
            // green center — measuring to the cup beats measuring to the middle.
            let headline = pin ?? center
            let headlineM = Distance.planarMeters(origin, headline)
            VStack(spacing: 2) {
                if pin != nil {
                    Text("PIN")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.yellow)
                }
                (Text("\(Int(headlineM.rounded()))")
                    .font(.system(size: 50, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                 + Text(" m")
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.secondary))
                    .contentTransition(.numericText())
                playsLikeRow(from: origin, hole: hole, target: headline)
                frontBackRow(from: origin, hole: hole, center: center, showsCenter: pin != nil)
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

    /// Elevation-adjusted "plays like" to the headline target (today's pin, or
    /// the green center), from the synced elevation grids (player elevation off
    /// the corridor/green tier, green elevation off the fine tier). Hidden
    /// whenever either sample is unavailable — straight distance is never
    /// wrong, plays-like can be.
    @ViewBuilder
    private func playsLikeRow(from origin: LatLon, hole: WatchHole, target: LatLon) -> some View {
        let p = Sweref99TM.fromWGS84(origin)
        let c = Sweref99TM.fromWGS84(target)
        let stats = zip2(
            hole.elevation(atE: p.x, n: p.y),
            hole.greenGrid?.elevation(atE: c.x, n: c.y)
        ).map { player, green in
            PlaysLike.segmentStats(
                PlaysLike.Point(e: p.x, n: p.y, elevation: player),
                PlaysLike.Point(e: c.x, n: c.y, elevation: green)
            )
        }
        if let stats, let plays = stats.playsLikeSimple, let delta = stats.elevationDelta {
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

    /// Both-or-nothing pairing of two optionals (a plays-like figure needs both
    /// elevation samples).
    private func zip2<A, B>(_ a: A?, _ b: B?) -> (A, B)? {
        guard let a, let b else { return nil }
        return (a, b)
    }

    /// Front / center / back under the headline. The center figure only shows
    /// when the pin took the headline — without a pin the headline IS center.
    @ViewBuilder
    private func frontBackRow(
        from origin: LatLon, hole: WatchHole, center: LatLon, showsCenter: Bool
    ) -> some View {
        let front = hole.greenFrontLatLon
        let back = hole.greenBackLatLon
        if front != nil || back != nil || showsCenter {
            HStack(spacing: 10) {
                if let front {
                    Text("F \(Int(Distance.planarMeters(origin, front).rounded()))")
                }
                if showsCenter {
                    Text("C \(Int(Distance.planarMeters(origin, center).rounded()))")
                }
                if let back {
                    Text("B \(Int(Distance.planarMeters(origin, back).rounded()))")
                }
            }
            .font(.footnote.weight(.medium))
            .monospacedDigit()
            .foregroundStyle(.secondary)
        }
    }

    /// AUTO shows while GPS drives the hole. A manual override (hole swipe)
    /// shows MANUAL instead — tap it to hand the hole back to GPS. The
    /// flanking chevrons hint the swipe.
    private var holeNavigation: some View {
        HStack {
            Image(systemName: "chevron.left")
                .foregroundStyle(selector.currentIndex == 0 ? .tertiary : .secondary)
            Spacer()
            if selector.isManual {
                Button {
                    selector.releaseManual()
                } label: {
                    Text("MANUAL")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.orange)
                }
                .buttonStyle(.bordered)
            } else {
                Text("AUTO")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(
                    selector.currentIndex >= course.holes.count - 1 ? .tertiary : .secondary
                )
        }
        .font(.footnote)
    }
}
