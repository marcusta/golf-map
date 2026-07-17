import Foundation

/// Pure contextual router for the one on-course laser entry (round-loop R7).
/// Feature context always wins over pin context: a rangefinder number aimed at
/// a picked mapped feature is calibration evidence, never a pin placement.
enum LaserInputRouter {
    enum Route: Equatable, Sendable {
        /// Feed the number into the existing PinEntrySheet laser-depth solve.
        case pinDepth
        /// Add the picked feature + number to a CalibrationSession solve.
        case calibrationShot
        /// Compare the picked feature + number with the live corrected origin.
        case residualCheck
        /// There is not enough trustworthy context to route this number.
        case unavailable
    }

    /// PinPhraseParser accepts a small bare number as a low-ranked candidate so
    /// phrases such as "6 from front, 20" remain recoverable. The single laser
    /// entry is stricter: a context-free number must be a plausible pin laser.
    static let plausiblePinDistanceM: ClosedRange<Double> = 40...1200

    static func route(
        distanceM: Double,
        hasPickedFeature: Bool,
        hasLiveCalibration: Bool,
        canSolvePin: Bool
    ) -> Route {
        guard distanceM.isFinite, distanceM > 0, distanceM <= 1200 else {
            return .unavailable
        }
        if hasPickedFeature {
            return hasLiveCalibration ? .residualCheck : .calibrationShot
        }
        guard canSolvePin, plausiblePinDistanceM.contains(distanceM) else {
            return .unavailable
        }
        return .pinDepth
    }
}

/// The free, advice-neutral readout every fixed-feature laser shot produces.
/// `mappedDistanceM` uses the corrected live fix when calibration is live and
/// the raw live fix otherwise; `deltaM` is laser − mapped distance.
struct LaserCarryCheck: Equatable, Sendable {
    var target: LatLon
    var laserDistanceM: Double
    var mappedDistanceM: Double

    var deltaM: Double { laserDistanceM - mappedDistanceM }
}
