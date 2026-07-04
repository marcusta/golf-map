import Foundation
import MapLibre

/// One tappable/rendered target marker on the map (green front/center/back,
/// or an active pin).
public struct TargetMarker: Equatable, Sendable {
    public enum Kind: String, Sendable, CaseIterable {
        case front
        case center
        case back
        case pin
    }

    public var kind: Kind
    public var position: LatLon

    public init(kind: Kind, position: LatLon) {
        self.kind = kind
        self.position = position
    }
}

/// User GPS position rendered as a custom dot (`CourseMapView` never enables
/// MapLibre's own user-location tracking — the app feeds CLLocation updates
/// through this instead, which keeps rendering identical on simulator).
public struct UserLocationMarker: Equatable, Sendable {
    public var position: LatLon

    public init(position: LatLon) {
        self.position = position
    }
}

/// Everything dynamic drawn on top of the course map. Value type — the
/// SwiftUI layer builds a new state and passes it to `CourseMapView`; updates
/// are cheap (shape reassignment on existing sources, no style reload).
public struct MapOverlayState: Equatable, Sendable {
    /// Distance line vertices in order (e.g. user/tee → target). Fewer than
    /// two points hides the line.
    public var distanceLine: [LatLon]
    /// Front/center/back/pin markers.
    public var targets: [TargetMarker]
    /// Custom GPS dot; nil hides it.
    public var userLocation: UserLocationMarker?

    public init(
        distanceLine: [LatLon] = [],
        targets: [TargetMarker] = [],
        userLocation: UserLocationMarker? = nil
    ) {
        self.distanceLine = distanceLine
        self.targets = targets
        self.userLocation = userLocation
    }

    public static let empty = MapOverlayState()
}

extension LatLon {
    var clCoordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}

/// Pure MapOverlayState → MLNShape conversion (no map view involved, so this
/// is unit-testable). An empty shape collection clears a source.
enum MapOverlayShapes {
    static func emptyShape() -> MLNShape { MLNShapeCollectionFeature(shapes: []) }

    static func distanceLineShape(_ points: [LatLon]) -> MLNShape {
        guard points.count >= 2 else { return emptyShape() }
        var coordinates = points.map(\.clCoordinate)
        return MLNPolylineFeature(coordinates: &coordinates, count: UInt(coordinates.count))
    }

    static func targetsShape(_ targets: [TargetMarker]) -> MLNShape {
        let features = targets.map { marker -> MLNPointFeature in
            let feature = MLNPointFeature()
            feature.coordinate = marker.position.clCoordinate
            feature.attributes = ["kind": marker.kind.rawValue]
            return feature
        }
        return MLNShapeCollectionFeature(shapes: features)
    }

    static func userLocationShape(_ marker: UserLocationMarker?) -> MLNShape {
        guard let marker else { return emptyShape() }
        let feature = MLNPointFeature()
        feature.coordinate = marker.position.clCoordinate
        return feature
    }
}

/// Pushes a `MapOverlayState` into the style's overlay shape sources.
/// Reassigning `MLNShapeSource.shape` is MapLibre's cheap data-update path —
/// no layer or style mutation.
@MainActor
enum MapOverlayRenderer {
    static func apply(_ state: MapOverlayState, to style: MLNStyle) {
        setShape(
            MapOverlayShapes.distanceLineShape(state.distanceLine),
            sourceID: MapStyleIDs.distanceLineSource,
            in: style
        )
        setShape(
            MapOverlayShapes.targetsShape(state.targets),
            sourceID: MapStyleIDs.targetsSource,
            in: style
        )
        setShape(
            MapOverlayShapes.userLocationShape(state.userLocation),
            sourceID: MapStyleIDs.userLocationSource,
            in: style
        )
    }

    private static func setShape(_ shape: MLNShape, sourceID: String, in style: MLNStyle) {
        guard let source = style.source(withIdentifier: sourceID) as? MLNShapeSource else {
            assertionFailure("Overlay source \(sourceID) missing from style")
            return
        }
        source.shape = shape
    }
}
