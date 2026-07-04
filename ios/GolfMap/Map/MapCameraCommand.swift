import Foundation

/// A declarative camera move for `CourseMapView`. The map applies a command
/// once when it changes (compared with `==`) and otherwise leaves the user's
/// freeform pan/zoom alone. Re-issuing an identical move (e.g. re-tapping the
/// same hole) requires bumping `token`.
public struct MapCameraCommand: Equatable, Sendable {
    public enum Target: Equatable, Sendable {
        /// Fit a WGS84 bbox in the viewport (with `padding`).
        case bounds(MapCoordinateBounds)
        /// Center on a point at a fixed zoom level.
        case center(LatLon, zoom: Double)
    }

    public var target: Target
    /// Map heading in degrees clockwise from north — the direction that ends
    /// up pointing "up" (pass the tee→green bearing for hole-direction-up).
    public var bearing: Double
    /// Uniform edge padding in points (only used for `.bounds`).
    public var padding: Double
    public var animated: Bool
    /// Change detector escape hatch: bump to force re-applying an otherwise
    /// equal command.
    public var token: Int

    public init(
        target: Target,
        bearing: Double = 0,
        padding: Double = 40,
        animated: Bool = true,
        token: Int = 0
    ) {
        self.target = target
        self.bearing = bearing
        self.padding = padding
        self.animated = animated
        self.token = token
    }

    /// Fit a hole's bbox with the hole direction pointing up.
    public static func fitHole(
        _ bounds: MapCoordinateBounds,
        bearing: Double = 0,
        padding: Double = 40,
        animated: Bool = true,
        token: Int = 0
    ) -> MapCameraCommand {
        MapCameraCommand(
            target: .bounds(bounds),
            bearing: bearing,
            padding: padding,
            animated: animated,
            token: token
        )
    }

    public static func center(
        _ point: LatLon,
        zoom: Double,
        bearing: Double = 0,
        animated: Bool = true,
        token: Int = 0
    ) -> MapCameraCommand {
        MapCameraCommand(
            target: .center(point, zoom: zoom),
            bearing: bearing,
            animated: animated,
            token: token
        )
    }
}
