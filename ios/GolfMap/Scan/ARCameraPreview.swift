import SwiftUI
#if canImport(ARKit)
import ARKit
import SceneKit
#endif

/// Live camera feed for the corridor scan, rendered from the session
/// `CorridorScanService` already runs — the view never runs or configures a
/// session of its own, it only displays one.
///
/// `ARSCNView` (not RealityKit's `ARView`) because its `session` property is
/// settable, which is what lets the service stay the owner of the session and
/// its frame delegate. Assigning a session can install the view as that
/// session's delegate, so `onAttach` re-asserts the real one — without it the
/// point collection would silently stop.
///
/// Nothing is added to the scene: this is a camera passthrough. The crosshair
/// and instructions are SwiftUI drawn on top.
struct ARCameraPreview: View {
    #if canImport(ARKit)
    let session: ARSession
    let onAttach: () -> Void

    var body: some View {
        Representable(session: session, onAttach: onAttach)
    }

    private struct Representable: UIViewRepresentable {
        let session: ARSession
        let onAttach: () -> Void

        func makeUIView(context: Context) -> ARSCNView {
            let view = ARSCNView(frame: .zero)
            view.isUserInteractionEnabled = false
            view.automaticallyUpdatesLighting = true
            view.rendersContinuously = true
            attach(view)
            return view
        }

        func updateUIView(_ view: ARSCNView, context: Context) {
            guard view.session !== session else { return }
            attach(view)
        }

        private func attach(_ view: ARSCNView) {
            view.session = session
            onAttach()
        }
    }
    #else
    var body: some View { Color.black }
    #endif
}

/// The aiming reticle: a ring with a centre dot, plus the live range readout.
/// Colour IS the state — green means the LiDAR has the surface under the
/// crosshair and the mark button will use it; grey means no depth there, so a
/// mark would fall back to the phone's own position.
struct AimCrosshair: View {
    /// Range to the point under the crosshair, nil when there is no hit.
    let distanceM: Double?

    private var hasHit: Bool { distanceM != nil }
    private var tint: Color { hasHit ? .green : .white.opacity(0.5) }

    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle()
                    .strokeBorder(tint, lineWidth: 2)
                    .frame(width: 44, height: 44)
                Circle()
                    .fill(tint)
                    .frame(width: 5, height: 5)
                // Tick marks, so the reticle reads as an instrument against
                // busy grass rather than dissolving into it.
                ForEach([0.0, 90.0, 180.0, 270.0], id: \.self) { angle in
                    Capsule()
                        .fill(tint)
                        .frame(width: 2, height: 8)
                        .offset(y: -30)
                        .rotationEffect(.degrees(angle))
                }
            }
            .shadow(color: .black.opacity(0.6), radius: 3)

            Text(distanceM.map { String(format: "%.2f m", $0) } ?? "no surface")
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.black.opacity(0.45), in: Capsule())
        }
        .animation(.easeOut(duration: 0.15), value: hasHit)
    }
}
