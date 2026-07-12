import Foundation
import Observation

/// App-wide user preferences — one observable source of truth, persisted to
/// `UserDefaults`, injected via `AppEnvironment` and read from the on-course
/// screens. Kept separate from `AppEnvironment` (which owns dependencies +
/// auth state) so a plain setting toggle doesn't churn the DI container.
///
/// **Competition mode (DMD local rule).** Under the Model Local Rule on
/// distance-measuring devices, only *distance* information is allowed in
/// competition — slope / plays-like adjustments are not. When
/// `competitionMode` is ON the app degrades gracefully: slope-adjusted
/// plays-like numbers are hidden on the on-course distance display and live
/// green reads gate themselves off (see `OnCourseDistances` and the putt-read
/// UI). Straight distances stay. Capturing an IMU spot-level is *measurement*,
/// not advice, so it is deliberately left available in competition mode — the
/// doc's competition mode concerns advice display, and a level reading feeds
/// calibration, not an on-course read (see `SpotLevelCaptureSheet`).
///
/// Default OFF (friendly rounds are the common case).
@MainActor
@Observable
final class AppSettings {
    @ObservationIgnored private let defaults: UserDefaults
    private static let competitionModeKey = "settings.competitionMode"
    private static let distanceUnitKey = "settings.distanceUnit"
    private static let defaultStimpKey = "settings.defaultStimpFt"
    /// Same key `AppEnvironment.resolvedServerOrigin()` reads at launch —
    /// deliberately shared so this is the one place the override is written.
    private static let serverOriginKey = "serverOrigin"

    /// When true, the app hides slope-adjusted advice (plays-like + live green
    /// reads) — distances only. Persisted; default OFF.
    var competitionMode: Bool {
        didSet {
            guard competitionMode != oldValue else { return }
            defaults.set(competitionMode, forKey: Self.competitionModeKey)
        }
    }

    /// Display unit for on-course distances (DesignSystem/DistanceFormat.swift
    /// converts at format time — internal math always stays metric). Persisted;
    /// default meters.
    var distanceUnit: DistanceUnit {
        didSet {
            guard distanceUnit != oldValue else { return }
            defaults.set(distanceUnit.rawValue, forKey: Self.distanceUnitKey)
        }
    }

    /// Seed stimp (ft, clamped 4–16) for a fresh `PuttReadModel` that has no
    /// persisted last-used value yet — the putt-read panel's own stimp slider
    /// keeps overriding it every round after that (see `PuttReadModel.init`).
    /// Persisted; default 10.
    var defaultStimpFt: Double {
        didSet {
            guard defaultStimpFt != oldValue else { return }
            defaults.set(defaultStimpFt, forKey: Self.defaultStimpKey)
        }
    }

    /// Server origin override, validated + normalized (scheme + host,
    /// trailing slash trimmed) — see `setServerOrigin`. Nil = use
    /// `AppEnvironment`'s built-in `http://localhost:3000` default. Takes
    /// effect on next launch (`AppEnvironment.serverOrigin` is fixed for the
    /// lifetime of the DI container — see `AppEnvironment.resolvedServerOrigin`).
    var serverOrigin: String? {
        didSet {
            guard serverOrigin != oldValue else { return }
            if let serverOrigin {
                defaults.set(serverOrigin, forKey: Self.serverOriginKey)
            } else {
                defaults.removeObject(forKey: Self.serverOriginKey)
            }
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Absent key → false (default OFF).
        self.competitionMode = defaults.bool(forKey: Self.competitionModeKey)
        self.distanceUnit = defaults.string(forKey: Self.distanceUnitKey)
            .flatMap(DistanceUnit.init(rawValue:)) ?? .meters
        let storedStimp = defaults.object(forKey: Self.defaultStimpKey) as? Double
        self.defaultStimpFt = storedStimp
            .map { min(PuttReadModel.stimpMaxFt, max(PuttReadModel.stimpMinFt, $0)) }
            ?? PuttReadModel.defaultStimpFt
        self.serverOrigin = defaults.string(forKey: Self.serverOriginKey)
    }

    /// Validates + normalizes a user-entered server origin and persists it
    /// (empty input clears the override, back to the built-in default).
    /// Returns false — without persisting anything — when a non-empty string
    /// fails validation, so the Settings screen can show an inline error.
    @discardableResult
    func setServerOrigin(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            serverOrigin = nil
            return true
        }
        guard let normalized = Self.normalizeServerOrigin(trimmed) else { return false }
        serverOrigin = normalized
        return true
    }

    /// A valid origin parses as a URL with both a scheme and a host (rejects
    /// empty strings, bare host:port with no scheme, path-only input, …).
    /// Trailing slashes are trimmed so the stored value composes cleanly with
    /// `GolfAPIClient`'s path-joining.
    static func normalizeServerOrigin(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme, !scheme.isEmpty,
              let host = url.host, !host.isEmpty
        else { return nil }
        var result = trimmed
        while result.hasSuffix("/") { result.removeLast() }
        return result
    }
}
