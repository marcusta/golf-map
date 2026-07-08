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

    /// When true, the app hides slope-adjusted advice (plays-like + live green
    /// reads) — distances only. Persisted; default OFF.
    var competitionMode: Bool {
        didSet {
            guard competitionMode != oldValue else { return }
            defaults.set(competitionMode, forKey: Self.competitionModeKey)
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Absent key → false (default OFF).
        self.competitionMode = defaults.bool(forKey: Self.competitionModeKey)
    }
}
