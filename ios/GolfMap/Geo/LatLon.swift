import Foundation

/// A WGS84 geographic point. Kept deliberately free of CoreLocation so the Geo
/// module has zero external dependencies; adapters to `CLLocationCoordinate2D`
/// or the API model types live in higher layers.
public struct LatLon: Sendable, Equatable, Hashable {
    public var lat: Double
    public var lon: Double

    public init(lat: Double, lon: Double) {
        self.lat = lat
        self.lon = lon
    }
}
