import CoreLocation
import Observation

/// Marks a shot position and reports the live distance from it.
///
/// The mark is a single stored coordinate; distance is always
/// `currentFix.distance(from: mark)`, so the value survives app suspension
/// (wrist down) and even a relaunch — the mark persists in UserDefaults.
@MainActor
@Observable
final class ShotTracker {
    struct Mark: Codable, Equatable {
        var latitude: Double
        var longitude: Double
        var timestamp: Date

        var location: CLLocation {
            CLLocation(latitude: latitude, longitude: longitude)
        }
    }

    private(set) var mark: Mark?
    private(set) var currentFix: CLLocation?
    private(set) var isUpdating = false
    private(set) var authorizationDenied = false

    private var updatesTask: Task<Void, Never>?
    private let defaults: UserDefaults
    private static let markKey = "shotMark"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.markKey),
           let saved = try? JSONDecoder().decode(Mark.self, from: data) {
            mark = saved
        }
    }

    /// Meters from the mark to the latest fix, nil until both exist.
    var distanceMeters: Double? {
        guard let mark, let currentFix else { return nil }
        return currentFix.distance(from: mark.location)
    }

    /// Horizontal accuracy of the latest fix in meters, nil when unknown.
    var accuracyMeters: Double? {
        guard let fix = currentFix, fix.horizontalAccuracy >= 0 else { return nil }
        return fix.horizontalAccuracy
    }

    func startUpdates() {
        guard updatesTask == nil else { return }
        isUpdating = true
        updatesTask = Task { [weak self] in
            do {
                // Prompts for when-in-use authorization on first use.
                for try await update in CLLocationUpdate.liveUpdates(.fitness) {
                    guard let self, !Task.isCancelled else { return }
                    // Denial diagnostics exist from watchOS 11; on 10.x we
                    // simply never show the denied hint.
                    if #available(watchOS 11.0, *), update.authorizationDenied {
                        self.authorizationDenied = true
                    }
                    if let location = update.location {
                        self.authorizationDenied = false
                        self.currentFix = location
                    }
                }
            } catch {
                self?.isUpdating = false
            }
        }
    }

    func stopUpdates() {
        updatesTask?.cancel()
        updatesTask = nil
        isUpdating = false
    }

    /// Stores the current fix as the shot position.
    func markShot() {
        guard let fix = currentFix else { return }
        let newMark = Mark(
            latitude: fix.coordinate.latitude,
            longitude: fix.coordinate.longitude,
            timestamp: fix.timestamp
        )
        mark = newMark
        if let data = try? JSONEncoder().encode(newMark) {
            defaults.set(data, forKey: Self.markKey)
        }
    }

    func clearMark() {
        mark = nil
        defaults.removeObject(forKey: Self.markKey)
    }
}
