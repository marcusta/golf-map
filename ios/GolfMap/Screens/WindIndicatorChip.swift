import SwiftUI

/// Wind indicator + editor entry point for the on-course control stack: a
/// compass arrow pointing the way the wind BLOWS (relative to the map's hole-up
/// framing) over the wind speed in m/s. The web planner shows the same direction
/// + speed; on iOS a SwiftUI chip in the control rail is the cleaner fit than an
/// offline on-map glyph (the style has no text glyph PBFs).
///
/// `wind` is nil when no wind is set — the chip then shows a calm state rather
/// than vanishing, because it is also the ONLY way into `WindEditorSheet`, and a
/// chip that hides itself when there is nothing to show would leave no way to
/// set the first wind of the round.
///
/// Shown in competition mode too: the wind comes off a weather report, not a
/// device reading of the course, and its "plays as" correction stays live there.
/// Competition mode's ban is on SLOPE and club advice, gated elsewhere.
struct WindIndicatorChip: View {
    /// The wind in effect on this hole, or nil for calm / not set. Speed is m/s
    /// (plan units — not a distance, so unaffected by the meters/yards display
    /// setting); direction is where the wind comes FROM, compass degrees.
    let wind: (speedMps: Double, directionDeg: Double)?
    /// Tee→green bearing = the map's "up" direction (camera bearing).
    let holeBearing: Double
    let action: () -> Void

    /// On-screen rotation for an up-pointing (north) arrow: the wind blows TO
    /// `directionDeg + 180`, and the map is rotated so `holeBearing` is up, so
    /// the screen angle from up is their difference.
    private var screenAngle: Double {
        guard let wind else { return 0 }
        return (wind.directionDeg + 180 - holeBearing).truncatingRemainder(dividingBy: 360)
    }

    private var speedText: String {
        guard let wind else { return "—" }
        return "\(Int(wind.speedMps.rounded()))"
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 0) {
                Image(systemName: wind == nil ? "wind" : "location.north.fill")
                    .font(.system(size: 14, weight: .bold))
                    .rotationEffect(.degrees(screenAngle))
                    .padding(.bottom, 1)
                Text(speedText)
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text("m/s")
                    .font(.system(size: 7, weight: .semibold))
                    .opacity(0.65)
            }
            .foregroundStyle(wind == nil ? Color.secondary : Color.primary)
            .frame(width: 44, height: 44)
            .mapControl()
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Opens the wind editor")
    }

    private var accessibilityLabel: String {
        guard let wind else { return "Wind: not set" }
        return "Wind \(speedText) meters per second, from \(Int(wind.directionDeg.rounded())) degrees"
    }
}
