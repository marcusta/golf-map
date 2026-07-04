import CoreLocation
import Observation

/// CLLocationManager wrapper for the on-course screen: when-in-use
/// authorization, continuous best-accuracy updates with a ~2 m distance
/// filter (live golf use), and a plain `LatLon` output the model consumes.
///
/// Lifecycle is explicit — the screen calls `start()` on appear / foreground
/// and `stop()` on disappear / background so GPS never runs off-course.
/// Denied/restricted authorization sets `isDenied` instead of erroring; the
/// screen then falls back to tee-based distances.
///
/// The manager is created on the main actor and CoreLocation delivers
/// delegate callbacks on the thread the manager was created on, so the
/// `@preconcurrency` delegate conformance is safe (same pattern as
/// `CourseMapView.Coordinator` with MLNMapViewDelegate).
@MainActor
@Observable
final class LocationProvider: NSObject, @preconcurrency CLLocationManagerDelegate {
    @ObservationIgnored private let manager = CLLocationManager()
    @ObservationIgnored private var isActive = false

    /// Latest usable GPS fix (invalid-accuracy fixes are dropped).
    private(set) var location: LatLon?
    /// Horizontal accuracy (meters) of the latest fix.
    private(set) var horizontalAccuracy: Double?
    /// True when authorization is denied/restricted — show tee-based fallback.
    private(set) var isDenied = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 2
        manager.activityType = .fitness
    }

    /// Requests authorization if needed and begins continuous updates.
    func start() {
        isActive = true
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            isDenied = true
        case .authorizedWhenInUse, .authorizedAlways:
            isDenied = false
            manager.startUpdatingLocation()
        @unknown default:
            break
        }
    }

    /// Stops updates (screen disappeared or app backgrounded).
    func stop() {
        isActive = false
        manager.stopUpdatingLocation()
    }

    // MARK: - CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .denied, .restricted:
            isDenied = true
            location = nil
            horizontalAccuracy = nil
        case .authorizedWhenInUse, .authorizedAlways:
            isDenied = false
            if isActive { manager.startUpdatingLocation() }
        case .notDetermined:
            break
        @unknown default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let fix = locations.last, fix.horizontalAccuracy >= 0 else { return }
        location = LatLon(lat: fix.coordinate.latitude, lon: fix.coordinate.longitude)
        horizontalAccuracy = fix.horizontalAccuracy
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // kCLErrorLocationUnknown is transient — keep the last fix and wait.
    }
}
