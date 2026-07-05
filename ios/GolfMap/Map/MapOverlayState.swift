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

/// One on-map route-leg distance label (immersive mode): the whole-metre
/// length of a route segment, anchored at the segment's midpoint. Rendered by
/// `RouteLegLabelRenderer` as a pre-rendered number image (the offline style
/// has no glyph PBFs, so symbol text cannot render).
public struct RouteLegLabel: Equatable, Sendable {
    public var midpoint: LatLon
    public var meters: Int

    public init(midpoint: LatLon, meters: Int) {
        self.midpoint = midpoint
        self.meters = meters
    }
}

/// The measure tool's rendered path: an amber polyline through every placed
/// point plus labelled point circles (first green, last red, mids amber —
/// mirrors the web measure overlay styling). Deliberately its OWN overlay
/// with its own sources: the GPS distance-line source is rewritten on every
/// GPS fix and must never fight the measure path.
public struct MeasureOverlay: Equatable, Sendable {
    /// Placed measure points in tap order. Empty hides the overlay.
    public var points: [LatLon]

    public init(points: [LatLon] = []) {
        self.points = points
    }

    public static let empty = MeasureOverlay()

    /// Point labels A, B, C, … (wraps past Z, which never happens for a path).
    public static func pointLabel(_ index: Int) -> String {
        String(UnicodeScalar(UInt8(65 + index % 26)))
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
    /// Measure-tool path (amber line + point circles); `.empty` hides it.
    public var measure: MeasureOverlay
    /// Per-leg distance labels printed along `distanceLine` (immersive mode
    /// only — the caller includes them when the chrome is hidden). Empty
    /// hides the labels.
    public var routeLegLabels: [RouteLegLabel]

    public init(
        distanceLine: [LatLon] = [],
        targets: [TargetMarker] = [],
        userLocation: UserLocationMarker? = nil,
        measure: MeasureOverlay = .empty,
        routeLegLabels: [RouteLegLabel] = []
    ) {
        self.distanceLine = distanceLine
        self.targets = targets
        self.userLocation = userLocation
        self.measure = measure
        self.routeLegLabels = routeLegLabels
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

    /// The measure path polyline (hidden below two points, like the distance
    /// line).
    static func measureLineShape(_ overlay: MeasureOverlay) -> MLNShape {
        distanceLineShape(overlay.points)
    }

    /// Measure point circles, tagged `kind` first/last/mid (drives the web
    /// palette: A green, last red, mids amber) and `label` A, B, C, … A single
    /// placed point is `first`.
    static func measurePointsShape(_ overlay: MeasureOverlay) -> MLNShape {
        let points = overlay.points
        let features = points.enumerated().map { index, position -> MLNPointFeature in
            let feature = MLNPointFeature()
            feature.coordinate = position.clCoordinate
            let kind = index == 0 ? "first" : (index == points.count - 1 ? "last" : "mid")
            feature.attributes = [
                "kind": kind,
                "label": MeasureOverlay.pointLabel(index),
            ]
            return feature
        }
        return MLNShapeCollectionFeature(shapes: features)
    }
}

/// Pushes a `MapOverlayState` into the style's overlay shape sources.
/// Reassigning `MLNShapeSource.shape` is MapLibre's cheap data-update path —
/// no layer or style mutation.
///
/// `routeLegLabels` is NOT applied here: label rendering needs a stateful
/// image cache (`RouteLegLabelRenderer`, owned by the coordinator), which the
/// coordinator invokes right after this.
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
        setShape(
            MapOverlayShapes.measureLineShape(state.measure),
            sourceID: MapStyleIDs.measureLineSource,
            in: style
        )
        setShape(
            MapOverlayShapes.measurePointsShape(state.measure),
            sourceID: MapStyleIDs.measurePointsSource,
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
