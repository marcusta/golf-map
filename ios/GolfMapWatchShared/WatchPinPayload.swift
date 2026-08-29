import Foundation

/// Today's pins for one course, as carried in the WatchConnectivity
/// *application context* (a latest-value dictionary, not a file transfer).
///
/// Pins are a daily fact placed mid-round, long after the course bundle was
/// synced, so they ride their own channel: the phone overwrites the context on
/// every change and the system delivers the newest one whenever the watch is
/// reachable (including at watch launch, via `receivedApplicationContext`).
///
/// Compiled into BOTH apps — the keys are the wire format.
public enum WatchPinPayload {
    public static let courseIdKey = "pinsCourseId"
    public static let dayKey = "pinsDay"
    public static let pinsKey = "pins"

    /// One decoded context: the course the pins belong to, the local day they
    /// were placed on, and `hole number → pin`.
    public struct Decoded: Equatable, Sendable {
        public var courseId: String
        public var day: String
        public var pins: [Int: LatLon]

        public init(courseId: String, day: String, pins: [Int: LatLon]) {
            self.courseId = courseId
            self.day = day
            self.pins = pins
        }
    }

    /// Local-calendar day (`yyyy-MM-dd`, en_US_POSIX, LOCAL time zone) — the
    /// same stamp the phone's pin overrides expire on.
    public static func dayString(_ date: Date) -> String { formatter.string(from: date) }

    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Wire dictionary. Hole numbers become string keys (property-list
    /// dictionaries can't key on Int).
    public static func encode(courseId: String, day: String, pins: [Int: LatLon]) -> [String: Any] {
        var encoded: [String: [Double]] = [:]
        for (number, pin) in pins { encoded[String(number)] = [pin.lat, pin.lon] }
        return [courseIdKey: courseId, dayKey: day, pinsKey: encoded]
    }

    /// Decodes a received context; nil when it is not a pin payload at all.
    /// Malformed individual entries are dropped, not fatal — an empty pin set
    /// is a legitimate payload (every pin cleared).
    public static func decode(_ context: [String: Any]) -> Decoded? {
        guard let courseId = context[courseIdKey] as? String,
              let day = context[dayKey] as? String else { return nil }
        var pins: [Int: LatLon] = [:]
        if let raw = context[pinsKey] as? [String: [Double]] {
            for (key, pair) in raw {
                guard let number = Int(key), pair.count >= 2 else { continue }
                pins[number] = LatLon(lat: pair[0], lon: pair[1])
            }
        }
        return Decoded(courseId: courseId, day: day, pins: pins)
    }
}
