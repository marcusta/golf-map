import SwiftUI

/// Effective-wind indicator for the on-course control stack: a compass arrow
/// pointing the way the wind BLOWS (relative to the map's hole-up framing) over
/// the wind speed in m/s. The web planner shows the same direction + speed; on
/// iOS a SwiftUI chip in the control rail is the cleaner fit than an offline
/// on-map glyph (the style has no text glyph PBFs).
///
/// Only shown when `OnCourseModel.effectiveWind` is non-nil — which is already
/// nil in competition mode, so this vanishes there alongside the rest of the
/// shot-viz overlay, no extra gating needed.
struct WindIndicatorChip: View {
    /// Wind speed, m/s (plan units — not a distance, so unaffected by the
    /// meters/yards display setting).
    let speedMps: Double
    /// Direction the wind comes FROM, compass degrees (meteorological).
    let directionDeg: Double
    /// Tee→green bearing = the map's "up" direction (camera bearing).
    let holeBearing: Double

    /// On-screen rotation for an up-pointing (north) arrow: the wind blows TO
    /// `directionDeg + 180`, and the map is rotated so `holeBearing` is up, so
    /// the screen angle from up is their difference.
    private var screenAngle: Double {
        (directionDeg + 180 - holeBearing).truncatingRemainder(dividingBy: 360)
    }

    private var speedText: String { "\(Int(speedMps.rounded()))" }

    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: "location.north.fill")
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
        .foregroundStyle(Color.primary)
        .frame(width: 44, height: 44)
        .mapControl()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "Wind \(speedText) meters per second, from \(Int(directionDeg.rounded())) degrees"
        )
    }
}
