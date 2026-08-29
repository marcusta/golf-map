import Foundation
import Observation

/// The watch's store of today's pins, received from the phone as a
/// WatchConnectivity *application context* (`WatchPinPayload`).
///
/// A pin is a daily fact: the store keeps the day it was placed on and reports
/// nothing once that day has passed, so yesterday's pin never quietly drives
/// today's distances. Persisted, so a pin survives the app being killed with
/// the phone out of reach.
@MainActor
@Observable
final class PinStore {

    /// The stored payload (course + day + pins), or nil when nothing has been
    /// received. Kept even when stale; `pin(courseId:holeNumber:)` is where the
    /// day is enforced.
    private(set) var stored: WatchPinPayload.Decoded?

    private let defaults: UserDefaults
    private let now: () -> Date
    private static let storeKey = "pinStore.context"

    init(defaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.now = now
        if let raw = defaults.dictionary(forKey: Self.storeKey) {
            stored = WatchPinPayload.decode(raw)
        }
    }

    /// Today's pin for one hole of one course, or nil (no pin, other course, or
    /// the payload is from an earlier day).
    func pin(courseId: String, holeNumber: Int) -> LatLon? {
        guard let stored, stored.courseId == courseId else { return nil }
        guard stored.day == WatchPinPayload.dayString(now()) else { return nil }
        return stored.pins[holeNumber]
    }

    /// Applies a decoded pin payload (decoding happens at the WCSession edge —
    /// `[String: Any]` is not Sendable, so it never crosses an actor hop).
    func apply(_ decoded: WatchPinPayload.Decoded) {
        stored = decoded
        defaults.set(
            WatchPinPayload.encode(
                courseId: decoded.courseId, day: decoded.day, pins: decoded.pins
            ),
            forKey: Self.storeKey
        )
    }
}
