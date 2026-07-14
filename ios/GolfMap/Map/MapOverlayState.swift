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
    /// Leg endpoints in route order — used to pull the label onto the visible
    /// part of the leg when its midpoint scrolls off-screen.
    public var start: LatLon
    public var end: LatLon
    /// True planar (SWEREF 99 TM) halfway point — the default anchor.
    public var midpoint: LatLon
    public var meters: Int

    public init(start: LatLon, end: LatLon, midpoint: LatLon, meters: Int) {
        self.start = start
        self.end = end
        self.midpoint = midpoint
        self.meters = meters
    }

    /// Convenience (tests / degenerate placement): start = end = midpoint.
    public init(midpoint: LatLon, meters: Int) {
        self.init(start: midpoint, end: midpoint, midpoint: midpoint, meters: meters)
    }
}

/// One draggable Adjust-mode handle: the active tee, an aim point, or the
/// green center. Rendered as a large kind-colored ring with a pre-rendered
/// text label ("T", "A1", "G" — the offline style has no glyph PBFs, so the
/// label is an image; see `AdjustHandleRenderer`). The same array drives the
/// drag hit-test in `CourseMapView` — `id` round-trips through the grab/move/
/// drop callbacks back to the model.
public struct AdjustHandle: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable, CaseIterable {
        case tee
        case aim
        case green
        /// Shot-capture crosshair (the position the stroke is played FROM).
        case shot
        /// Shot-capture intended target (optional secondary drag).
        case target
        /// A planner-tool planned landing point (draggable while editing).
        case planShot
    }

    /// Stable element id (model-owned scheme, e.g. "tee" / "aim.<id>" / "green").
    public var id: String
    public var kind: Kind
    /// Short on-map label ("T", "A1", "A2", "G").
    public var label: String
    public var position: LatLon

    public init(id: String, kind: Kind, label: String, position: LatLon) {
        self.id = id
        self.kind = kind
        self.label = label
        self.position = position
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

/// The game-plan strategy overlay for the active hole (read-only viewer of
/// plans built on the web): leg polyline tee → shot 1 → … → green center,
/// the planned landing points as nodes, and the target gates as cross-lines
/// (endpoints precomputed in planar SWEREF 99 TM — see `CoursePlan.Gate`).
/// Deliberately its OWN sources and a distinct dashed-violet style: the plan
/// is "the strategy"; the white distance line is "where I am". No on-map
/// text — clubs/labels/leg meters live in the distance card (the offline
/// style has no glyph PBFs).
public struct PlanOverlay: Equatable, Sendable {
    /// One gate cross-line, already resolved to its two endpoints.
    public struct GateLine: Equatable, Sendable {
        public var left: LatLon
        public var right: LatLon

        public init(left: LatLon, right: LatLon) {
            self.left = left
            self.right = right
        }
    }

    /// Leg polyline vertices in order (tee → shots… → green center). Fewer
    /// than two points hides the line (nodes/gates still render).
    public var line: [LatLon]
    /// Planned landing points (shot nodes), tee→green order.
    public var nodes: [LatLon]
    /// Target gate cross-lines.
    public var gates: [GateLine]
    /// Per-leg dispersion ellipse polygons (shot-viz overlay). Empty in
    /// competition mode / without a bag.
    public var ellipses: [PlanStrategy.EllipseShape]
    /// Recommended-aim ghost groups (aim marker + dashed pattern + finish dot
    /// + drift connector). Empty in competition mode / without a bag.
    public var ghosts: [PlanStrategy.GhostShape]
    /// Approach-leg confidence tints (red/yellow/green). Empty in competition
    /// mode / without a bag.
    public var legTints: [PlanStrategy.LegTintShape]

    public init(
        line: [LatLon] = [],
        nodes: [LatLon] = [],
        gates: [GateLine] = [],
        ellipses: [PlanStrategy.EllipseShape] = [],
        ghosts: [PlanStrategy.GhostShape] = [],
        legTints: [PlanStrategy.LegTintShape] = []
    ) {
        self.line = line
        self.nodes = nodes
        self.gates = gates
        self.ellipses = ellipses
        self.ghosts = ghosts
        self.legTints = legTints
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
    /// Adjust-mode draggable handles (tee / aim points / green center); empty
    /// hides them. Also the drag hit-test set in `CourseMapView`.
    public var adjustHandles: [AdjustHandle]
    /// Game-plan strategy overlay for the active hole; nil hides it (course
    /// has no plan, hole has no plan content, or the plan toggle is off).
    public var plan: PlanOverlay?
    /// The feature a tapped distance-ladder row focused (cyan ring); nil hides
    /// it. Cleared with the camera focus (`recenter()` / hole change).
    public var highlight: LatLon?
    /// The selected target's recommended-club dispersion ellipse (closed WGS84
    /// ring); nil hides it.
    public var selectedEllipse: [LatLon]?

    public init(
        distanceLine: [LatLon] = [],
        targets: [TargetMarker] = [],
        userLocation: UserLocationMarker? = nil,
        measure: MeasureOverlay = .empty,
        routeLegLabels: [RouteLegLabel] = [],
        adjustHandles: [AdjustHandle] = [],
        plan: PlanOverlay? = nil,
        highlight: LatLon? = nil,
        selectedEllipse: [LatLon]? = nil
    ) {
        self.distanceLine = distanceLine
        self.targets = targets
        self.userLocation = userLocation
        self.measure = measure
        self.routeLegLabels = routeLegLabels
        self.adjustHandles = adjustHandles
        self.plan = plan
        self.highlight = highlight
        self.selectedEllipse = selectedEllipse
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

    /// The ladder tap-highlight point (empty collection hides the ring).
    static func highlightShape(_ position: LatLon?) -> MLNShape {
        guard let position else { return emptyShape() }
        let feature = MLNPointFeature()
        feature.coordinate = position.clCoordinate
        return feature
    }

    /// The selected-target dispersion ellipse as a filled polygon (needs ≥ 3
    /// points; empty collection hides it).
    static func selectedEllipseShape(_ polygon: [LatLon]?) -> MLNShape {
        guard let polygon, polygon.count >= 3 else { return emptyShape() }
        var coordinates = polygon.map(\.clCoordinate)
        return MLNPolygonFeature(coordinates: &coordinates, count: UInt(coordinates.count))
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

    // MARK: Game-plan overlay

    /// The plan leg polyline (hidden below two points, like the distance line).
    static func planLineShape(_ plan: PlanOverlay?) -> MLNShape {
        distanceLineShape(plan?.line ?? [])
    }

    /// Planned landing points as point features.
    static func planNodesShape(_ plan: PlanOverlay?) -> MLNShape {
        let features = (plan?.nodes ?? []).map { position -> MLNPointFeature in
            let feature = MLNPointFeature()
            feature.coordinate = position.clCoordinate
            return feature
        }
        return MLNShapeCollectionFeature(shapes: features)
    }

    /// Each gate as its own two-point polyline (left → right endpoint).
    static func planGatesShape(_ plan: PlanOverlay?) -> MLNShape {
        let features = (plan?.gates ?? []).map { gate -> MLNPolylineFeature in
            var coordinates = [gate.left.clCoordinate, gate.right.clCoordinate]
            return MLNPolylineFeature(coordinates: &coordinates, count: UInt(coordinates.count))
        }
        return MLNShapeCollectionFeature(shapes: features)
    }

    /// Per-leg dispersion ellipse polygons (fill + outline share the source).
    static func planEllipsesShape(_ plan: PlanOverlay?) -> MLNShape {
        let features = (plan?.ellipses ?? []).compactMap { ellipse -> MLNPolygonFeature? in
            guard ellipse.polygon.count >= 3 else { return nil }
            var coordinates = ellipse.polygon.map(\.clCoordinate)
            return MLNPolygonFeature(coordinates: &coordinates, count: UInt(coordinates.count))
        }
        return MLNShapeCollectionFeature(shapes: features)
    }

    /// Approach-leg confidence-tint segments, tagged `light` (green/yellow/red)
    /// for the data-driven line color.
    static func planLegTintsShape(_ plan: PlanOverlay?) -> MLNShape {
        let features = (plan?.legTints ?? []).compactMap { tint -> MLNPolylineFeature? in
            guard tint.line.count >= 2 else { return nil }
            var coordinates = tint.line.map(\.clCoordinate)
            let feature = MLNPolylineFeature(coordinates: &coordinates, count: UInt(coordinates.count))
            feature.attributes = ["light": tint.light.rawValue]
            return feature
        }
        return MLNShapeCollectionFeature(shapes: features)
    }

    /// The ghost recommended-aim group as one mixed collection, each feature
    /// tagged `role` (ghost-ellipse / ghost-drift lines, ghost-center /
    /// ghost-aim points) so a single source backs role-filtered layers.
    static func planGhostShape(_ plan: PlanOverlay?) -> MLNShape {
        var features: [MLNShape] = []
        for ghost in plan?.ghosts ?? [] {
            if ghost.ellipse.count >= 2 {
                var ring = ghost.ellipse.map(\.clCoordinate)
                let line = MLNPolylineFeature(coordinates: &ring, count: UInt(ring.count))
                line.attributes = ["role": "ghost-ellipse"]
                features.append(line)
            }
            if let drift = ghost.driftLine, drift.count >= 2 {
                var coordinates = drift.map(\.clCoordinate)
                let line = MLNPolylineFeature(coordinates: &coordinates, count: UInt(coordinates.count))
                line.attributes = ["role": "ghost-drift"]
                features.append(line)
            }
            let center = MLNPointFeature()
            center.coordinate = ghost.center.clCoordinate
            center.attributes = ["role": "ghost-center"]
            features.append(center)

            let aim = MLNPointFeature()
            aim.coordinate = ghost.aim.clCoordinate
            aim.attributes = ["role": "ghost-aim"]
            features.append(aim)
        }
        return MLNShapeCollectionFeature(shapes: features)
    }
}

/// Pushes a `MapOverlayState` into the style's overlay shape sources.
/// Reassigning `MLNShapeSource.shape` is MapLibre's cheap data-update path —
/// no layer or style mutation.
///
/// `routeLegLabels` and `adjustHandles` are NOT applied here: their label
/// rendering needs stateful image caches (`RouteLegLabelRenderer` /
/// `AdjustHandleRenderer`, owned by the coordinator), which the coordinator
/// invokes right after this.
@MainActor
enum MapOverlayRenderer {
    static func apply(_ state: MapOverlayState, to style: MLNStyle) {
        setShape(
            MapOverlayShapes.planLineShape(state.plan),
            sourceID: MapStyleIDs.planLineSource,
            in: style
        )
        setShape(
            MapOverlayShapes.planGatesShape(state.plan),
            sourceID: MapStyleIDs.planGatesSource,
            in: style
        )
        setShape(
            MapOverlayShapes.planNodesShape(state.plan),
            sourceID: MapStyleIDs.planNodesSource,
            in: style
        )
        setShape(
            MapOverlayShapes.planEllipsesShape(state.plan),
            sourceID: MapStyleIDs.planEllipsesSource,
            in: style
        )
        setShape(
            MapOverlayShapes.planLegTintsShape(state.plan),
            sourceID: MapStyleIDs.planLegTintsSource,
            in: style
        )
        setShape(
            MapOverlayShapes.planGhostShape(state.plan),
            sourceID: MapStyleIDs.planGhostSource,
            in: style
        )
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
        setShape(
            MapOverlayShapes.highlightShape(state.highlight),
            sourceID: MapStyleIDs.highlightSource,
            in: style
        )
        setShape(
            MapOverlayShapes.selectedEllipseShape(state.selectedEllipse),
            sourceID: MapStyleIDs.selectedEllipseSource,
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
