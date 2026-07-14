import SwiftUI

/// On-course wind editor, reached by tapping the wind chip in the control rail.
///
/// Wind is the one plan input that changes hour to hour, and until now it could
/// only be set in the web planner — so this is the on-course write path into the
/// SAME two-level plan wind the viewer already reads: a course-wide plan wind,
/// with an optional per-hole override that wins on that hole
/// (`CoursePlan.wind(holeNumber:)`). The scope picker chooses which one an edit
/// writes; switching scope migrates the value so an edit is never a no-op:
///  - → This hole: writes the current values as the hole's override.
///  - → All holes: clears the hole override (so the plan wind applies again)
///    and writes the current values as the plan wind.
///
/// Edits apply on GESTURE END (slider release / dial drop), not per frame: each
/// one is a GRDB write + sync flush, and the sheet's medium detent leaves the
/// map and distance card visible behind it, so the numbers update live as you
/// settle a value. `Done` only dismisses — there is nothing left to commit.
///
/// Competition mode does NOT hide this, and does not blunt it either: the wind
/// comes off a weather report, not a device reading of the course, so the wind
/// "plays as" distances stay live there. What competition still withholds is
/// SLOPE (plays-like, the elevation delta) and club advice — so in competition
/// the wind figures ride on the straight distance, never on plays-like.
struct WindEditorSheet: View {
    @Bindable var model: OnCourseModel
    let onClose: () -> Void

    /// Which level of the plan an edit writes.
    enum Scope: Hashable {
        case allHoles
        case thisHole
    }

    @State private var scope: Scope
    /// Wind speed, m/s (plan units — not a distance, so unaffected by the
    /// meters/yards display setting).
    @State private var speedMps: Double
    /// Direction the wind comes FROM, compass degrees (meteorological).
    @State private var directionDeg: Double

    /// Speed slider range: 0 (calm) to a hard blow. 20 m/s ≈ 45 mph — well past
    /// anything playable, so the top of the slider is never the binding limit.
    static let maxSpeedMps: Double = 20

    init(model: OnCourseModel, onClose: @escaping () -> Void) {
        self.model = model
        self.onClose = onClose
        let override = model.currentHoleWindOverride
        let wind = model.effectiveWind
        _scope = State(initialValue: override != nil ? .thisHole : .allHoles)
        _speedMps = State(initialValue: wind?.speedMps ?? 0)
        // No wind set yet → seed the dial as a dead headwind (the hole's own
        // bearing), so the first drag starts from a meaningful place rather
        // than from due north.
        _directionDeg = State(initialValue: wind?.directionDeg ?? model.holeBearing)
    }

    private var holeNumber: Int? { model.currentHole?.hole.number }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    WindDial(
                        directionDeg: $directionDeg,
                        speedMps: speedMps,
                        holeBearing: model.holeBearing,
                        onCommit: { apply() }
                    )
                    .frame(width: 220, height: 220)
                    .padding(.top, 8)

                    speedControls
                    componentsReadout
                    scopePicker
                    calmButton
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .navigationTitle("Wind")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: - Speed

    private var speedControls: some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(String(format: "%.1f m/s", speedMps))
                    .font(.system(size: 24, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                Text(String(format: "%.0f mph", mpsToMph(speedMps)))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Spacer()
                Text(speedMps < 0.25 ? "Calm" : beaufortish)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Slider(
                value: $speedMps,
                in: 0...Self.maxSpeedMps,
                step: 0.5,
                onEditingChanged: { editing in
                    // Commit on release, not per frame — every apply is a DB
                    // write + a sync flush.
                    if !editing { apply() }
                }
            )
            .accessibilityLabel("Wind speed")
            .accessibilityValue(String(format: "%.1f meters per second", speedMps))
        }
    }

    /// A plain-language strength cue (not the real Beaufort scale — just the
    /// bands a player actually distinguishes).
    private var beaufortish: String {
        switch speedMps {
        case ..<2: "Light"
        case ..<5: "Breezy"
        case ..<8: "Strong"
        case ..<12: "Hard"
        default: "Brutal"
        }
    }

    // MARK: - Head/cross readout (relative to the hole)

    /// The wind decomposed along the hole's tee→green line — the two numbers a
    /// player actually plays off. Same math as the strategy engine
    /// (`windComponents`), converted back to m/s for display.
    private var componentsReadout: some View {
        let components = windComponents(speedMps, directionDeg, model.holeBearing)
        let headTail = mphToMps(components.headTailMph)
        let cross = mphToMps(components.crosswindMph)
        let alongLabel = headTail < 0 ? "Into" : "Down"
        // crosswindMph > 0 = wind from the shooter's LEFT (pushes the ball right).
        let crossLabel = cross >= 0 ? "From left" : "From right"

        return HStack(spacing: 12) {
            componentTile(
                title: alongLabel,
                value: String(format: "%.1f", abs(headTail)),
                caption: "m/s along"
            )
            componentTile(
                title: crossLabel,
                value: String(format: "%.1f", abs(cross)),
                caption: "m/s across"
            )
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(alongLabel) \(String(format: "%.1f", abs(headTail))) meters per second along the hole, "
            + "\(crossLabel.lowercased()) \(String(format: "%.1f", abs(cross))) across"
        )
    }

    private func componentTile(title: String, value: String, caption: String) -> some View {
        VStack(spacing: 2) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .monospacedDigit()
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Scope

    private var scopePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("Applies to", selection: $scope) {
                Text("All holes").tag(Scope.allHoles)
                Text(holeNumber.map { "Hole \($0) only" } ?? "This hole only").tag(Scope.thisHole)
            }
            .pickerStyle(.segmented)
            .onChange(of: scope) { _, newScope in migrate(to: newScope) }

            Text(scope == .allHoles
                 ? "The course-wide wind — every hole without its own override."
                 : "Overrides the course-wide wind on this hole only.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var calmButton: some View {
        Button(role: .destructive) {
            speedMps = 0
            clear()
        } label: {
            Text(scope == .allHoles ? "Clear wind (calm)" : "Clear this hole's override")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
    }

    // MARK: - Writes

    /// Write the current dial + slider values at the current scope.
    private func apply() {
        switch scope {
        case .allHoles:
            model.setPlanWind(speedMps: speedMps, directionDeg: directionDeg)
        case .thisHole:
            model.setCurrentHoleWind(speedMps: speedMps, directionDeg: directionDeg)
        }
    }

    /// Clear the wind at the current scope: calm course-wide, or drop the hole's
    /// override so it inherits the plan wind again.
    private func clear() {
        switch scope {
        case .allHoles:
            model.setPlanWind(speedMps: nil, directionDeg: nil)
        case .thisHole:
            model.setCurrentHoleWind(speedMps: nil, directionDeg: nil)
            // Back to inheriting — show what the hole now actually plays with.
            if let inherited = model.effectiveWind {
                speedMps = inherited.speedMps
                directionDeg = inherited.directionDeg
            }
        }
    }

    /// Scope switch: carry the values across so the new scope takes effect
    /// immediately (an edit under a scope that a stale override would shadow is
    /// an invisible no-op — the exact confusion this avoids).
    private func migrate(to newScope: Scope) {
        switch newScope {
        case .thisHole:
            model.setCurrentHoleWind(speedMps: speedMps, directionDeg: directionDeg)
        case .allHoles:
            // Drop the override FIRST, else the plan wind stays shadowed on
            // this hole and the sheet would look broken.
            model.setCurrentHoleWind(speedMps: nil, directionDeg: nil)
            model.setPlanWind(speedMps: speedMps, directionDeg: directionDeg)
        }
    }
}

// MARK: - Dial

/// Drag-to-set wind direction, drawn HOLE-UP like the map: the hole plays
/// straight up the dial, so the arrow shows the wind exactly as it hits the
/// shot. The knob is the arrow HEAD — it sits where the wind blows TO, matching
/// `WindIndicatorChip`, and the stored `directionDeg` is the compass direction
/// the wind comes FROM (meteorological), 180° opposite.
private struct WindDial: View {
    @Binding var directionDeg: Double
    let speedMps: Double
    let holeBearing: Double
    let onCommit: () -> Void

    /// Screen angle (0 = up the dial, clockwise) of the way the wind blows.
    private var blowScreenAngle: Double {
        (directionDeg + 180 - holeBearing).truncatingRemainder(dividingBy: 360)
    }

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            let center = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
            let radius = size / 2

            ZStack {
                Circle()
                    .fill(.quaternary.opacity(0.35))
                Circle()
                    .strokeBorder(.tertiary, lineWidth: 1)

                // The hole: plays straight up the dial.
                VStack(spacing: 2) {
                    Text("HOLE")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.secondary)
                    Image(systemName: "arrow.up")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.top, 10)

                // The wind arrow, pointing the way the wind blows.
                Image(systemName: "location.north.fill")
                    .font(.system(size: 34, weight: .bold))
                    .rotationEffect(.degrees(blowScreenAngle))
                    .foregroundStyle(speedMps < 0.25 ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.tint))

                // The draggable knob at the arrow head.
                Circle()
                    .fill(.tint)
                    .frame(width: 26, height: 26)
                    .overlay(Circle().strokeBorder(.background, lineWidth: 2))
                    .position(knobPosition(center: center, radius: radius * 0.78))
                    .shadow(radius: 2, y: 1)

                Text("\(Int(directionDeg.rounded()))°")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .offset(y: radius * 0.45)
            }
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        update(from: value.location, center: center)
                    }
                    .onEnded { _ in onCommit() }
            )
            .accessibilityElement()
            .accessibilityLabel("Wind direction")
            .accessibilityValue("From \(Int(directionDeg.rounded())) degrees")
            .accessibilityAdjustableAction { direction in
                // ±5° per swipe — VoiceOver's way onto the dial.
                let delta: Double = direction == .increment ? 5 : -5
                directionDeg = normalized(directionDeg + delta)
                onCommit()
            }
        }
    }

    private func knobPosition(center: CGPoint, radius: CGFloat) -> CGPoint {
        let radians = blowScreenAngle * .pi / 180
        return CGPoint(
            x: center.x + radius * sin(radians),
            y: center.y - radius * cos(radians)
        )
    }

    /// Touch point → the way the wind blows (screen) → the compass direction it
    /// comes FROM. The inverse of `blowScreenAngle`.
    private func update(from point: CGPoint, center: CGPoint) {
        let dx = point.x - center.x
        let dy = center.y - point.y
        // Dead centre carries no direction — ignore rather than snap to north.
        guard abs(dx) > 0.5 || abs(dy) > 0.5 else { return }
        let screenAngle = atan2(dx, dy) * 180 / .pi
        directionDeg = normalized(screenAngle + holeBearing + 180)
    }

    private func normalized(_ degrees: Double) -> Double {
        let wrapped = degrees.truncatingRemainder(dividingBy: 360)
        return wrapped < 0 ? wrapped + 360 : wrapped
    }
}
