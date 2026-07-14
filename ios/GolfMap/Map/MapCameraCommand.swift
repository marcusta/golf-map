import Foundation

/// Extra per-edge camera padding, in points, added ON TOP of a command's
/// uniform `padding`. Lets a fit account for chrome that covers the map (the
/// hole header at the top, a tool panel at the bottom) so the fitted shape
/// lands centered in the VISIBLE part of the map, not the full viewport.
public struct MapEdgeInsets: Equatable, Sendable {
    public var top: Double
    public var left: Double
    public var bottom: Double
    public var right: Double

    public static let zero = MapEdgeInsets()

    public init(top: Double = 0, left: Double = 0, bottom: Double = 0, right: Double = 0) {
        self.top = top
        self.left = left
        self.bottom = bottom
        self.right = right
    }
}

/// A declarative camera move for `CourseMapView`. The map applies a command
/// once when it changes (compared with `==`) and otherwise leaves the user's
/// freeform pan/zoom alone. Re-issuing an identical move (e.g. re-tapping the
/// same hole) requires bumping `token`.
public struct MapCameraCommand: Equatable, Sendable {
    public enum Target: Equatable, Sendable {
        /// Fit a WGS84 bbox in the viewport (with `padding`).
        case bounds(MapCoordinateBounds)
        /// Fit an arbitrary WGS84 ring (e.g. a green outline) in the viewport.
        /// Tighter than `.bounds` whenever the camera is rotated: a north-up
        /// bbox has to grow to cover the shape once the map is turned to the
        /// hole bearing, and that slack is what you see as extra surrounds.
        case shape([LatLon])
        /// Center on a point at a fixed zoom level.
        case center(LatLon, zoom: Double)
    }

    public var target: Target
    /// Map heading in degrees clockwise from north — the direction that ends
    /// up pointing "up" (pass the tee→green bearing for hole-direction-up).
    public var bearing: Double
    /// Uniform edge padding in points (only used for `.bounds`).
    public var padding: Double
    /// Extra per-edge padding on top of `padding` — the map chrome covering the
    /// viewport (only used for `.bounds`).
    public var insets: MapEdgeInsets
    public var animated: Bool
    /// Change detector escape hatch: bump to force re-applying an otherwise
    /// equal command.
    public var token: Int

    public init(
        target: Target,
        bearing: Double = 0,
        padding: Double = 40,
        insets: MapEdgeInsets = .zero,
        animated: Bool = true,
        token: Int = 0
    ) {
        self.target = target
        self.bearing = bearing
        self.padding = padding
        self.insets = insets
        self.animated = animated
        self.token = token
    }

    /// Fit a hole's bbox with the hole direction pointing up.
    public static func fitHole(
        _ bounds: MapCoordinateBounds,
        bearing: Double = 0,
        padding: Double = 40,
        insets: MapEdgeInsets = .zero,
        animated: Bool = true,
        token: Int = 0
    ) -> MapCameraCommand {
        MapCameraCommand(
            target: .bounds(bounds),
            bearing: bearing,
            padding: padding,
            insets: insets,
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

/// An imperative relative-zoom request for `CourseMapView` — bump the map's
/// current zoom level by `delta` (positive = zoom in), keeping the center.
/// Deliberately separate from `MapCameraCommand`: zoom buttons drive this so a
/// tap never triggers a hole re-fit and never fights the hole-fit camera. The
/// map applies it once when it changes (compared with `==`); re-issuing an
/// identical delta requires bumping `token`.
public struct MapZoomCommand: Equatable, Sendable {
    /// Zoom-level change to add to the map's current level (≈ 1 per button tap).
    public var delta: Double
    public var animated: Bool
    /// Change detector escape hatch — bump to re-apply an otherwise equal delta
    /// (e.g. tapping "+" twice in a row).
    public var token: Int

    public init(delta: Double, animated: Bool = true, token: Int = 0) {
        self.delta = delta
        self.animated = animated
        self.token = token
    }
}
