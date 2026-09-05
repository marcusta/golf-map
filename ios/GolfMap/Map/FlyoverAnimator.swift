import MapLibre
import QuartzCore
import UIKit

/// Drives a `FlyoverPlan` on an `MLNMapView`: one camera per display frame
/// from the plan's pose model, then a hold, then an animated return to the
/// camera the map had when the flight began. `stop` cancels at any point.
@MainActor
final class FlyoverAnimator {
    private(set) var isFlying = false
    private var plan: FlyoverPlan?
    private weak var mapView: MLNMapView?
    private var displayLink: CADisplayLink?
    private var startTime: CFTimeInterval = 0
    private var savedCamera: MLNMapCamera?
    private var savedContentInset: UIEdgeInsets = .zero
    private var onEnd: (() -> Void)?

    /// Duration of the animated return to the pre-flight camera.
    static let restoreDuration: TimeInterval = 0.8

    /// Starts `plan`; a flight already in progress is replaced without a
    /// restore (the original pre-flight camera stays the restore target).
    func start(_ plan: FlyoverPlan, in mapView: MLNMapView, onEnd: @escaping () -> Void) {
        if isFlying {
            displayLink?.invalidate()
            displayLink = nil
        } else {
            savedCamera = mapView.camera.copy() as? MLNMapCamera
            savedContentInset = mapView.contentInset
        }
        self.plan = plan
        self.mapView = mapView
        self.onEnd = onEnd
        isFlying = true
        startTime = CACurrentMediaTime()
        // The flight frames everything itself; the chrome inset would offset
        // the look-at point.
        mapView.setContentInset(.zero, animated: false, completionHandler: nil)
        mapView.setCamera(Self.camera(for: plan.pose(atTime: 0)), animated: false)
        let link = CADisplayLink(target: FrameTarget(self), selector: #selector(FrameTarget.tick(_:)))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    /// Ends the flight. With `restoreCamera` the map animates back to the
    /// pre-flight camera; without it the pitch is levelled in place and the
    /// caller's next camera command takes over.
    func stop(restoreCamera: Bool) {
        guard isFlying else { return }
        displayLink?.invalidate()
        displayLink = nil
        isFlying = false
        plan = nil
        if let mapView {
            if restoreCamera, let savedCamera {
                mapView.setContentInset(savedContentInset, animated: false, completionHandler: nil)
                mapView.setCamera(
                    savedCamera,
                    withDuration: Self.restoreDuration,
                    animationTimingFunction: CAMediaTimingFunction(name: .easeInEaseOut)
                )
            } else {
                let level = mapView.camera.copy() as! MLNMapCamera
                level.pitch = 0
                mapView.setCamera(level, animated: false)
            }
        }
        savedCamera = nil
        onEnd = nil
    }

    /// Cancels without touching the camera (view teardown).
    func cancel() {
        displayLink?.invalidate()
        displayLink = nil
        isFlying = false
        plan = nil
        savedCamera = nil
        onEnd = nil
    }

    fileprivate func frame() {
        guard isFlying, let plan, let mapView else { return }
        let elapsed = CACurrentMediaTime() - startTime
        if elapsed >= plan.totalDuration {
            let onEnd = self.onEnd
            stop(restoreCamera: true)
            onEnd?()
            return
        }
        mapView.setCamera(Self.camera(for: plan.pose(atTime: elapsed)), animated: false)
    }

    static func camera(for pose: FlyoverPose) -> MLNMapCamera {
        MLNMapCamera(
            lookingAtCenter: pose.center.clCoordinate,
            altitude: pose.altitude,
            pitch: pose.pitch,
            heading: pose.heading
        )
    }

    /// Objective-C selector target for the display link; holds the animator
    /// weakly so an abandoned link never keeps it alive.
    @MainActor
    private final class FrameTarget: NSObject {
        weak var animator: FlyoverAnimator?
        init(_ animator: FlyoverAnimator) { self.animator = animator }
        /// The display link fires on the main run loop.
        @objc func tick(_ link: CADisplayLink) {
            animator?.frame()
        }
    }
}

/// A passive recognizer that reports the first touch-down and then fails, so
/// the map's own gestures are unaffected. Used to cancel a flyover on touch.
final class TouchDownRecognizer: UIGestureRecognizer {
    private let onTouchDown: () -> Void

    init(onTouchDown: @escaping () -> Void) {
        self.onTouchDown = onTouchDown
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        onTouchDown()
        state = .failed
    }
}
