import Foundation
import MapLibre
import UIKit

/// Stable identifiers for the putt-read overlay layers (runtime-added, like
/// the Green-view analysis layers — never part of `MapStyleBuilder`'s JSON).
public enum PuttOverlayMapIDs {
    public static let refSource = "putt-ref"
    public static let refLayer = "putt-ref"
    public static let pathSource = "putt-path"
    public static let pathCasingLayer = "putt-path-casing"
    public static let pathLayer = "putt-path"
    public static let stationArrowsSource = "putt-station-arrows"
    public static let stationArrowsCasingLayer = "putt-station-arrows-casing"
    public static let stationArrowsLineLayer = "putt-station-arrows-line"
    public static let stationLabelsSource = "putt-station-labels"
    public static let stationLabelsLayer = "putt-station-labels"
    static let stationLabelImagePrefix = "putt-station-label-"
    public static let pointsSource = "putt-points"
    public static let aimLayer = "putt-aim"
    public static let holeLayer = "putt-hole"
    public static let ballLayer = "putt-ball"
}

/// Renders one `PuttReadGeometry.PuttOverlay` onto the course map: the dashed
/// straight ball→hole reference line, the simulated break-path polyline
/// (white casing + blue core, amber when softened), local slope-% stations
/// with downhill arrows, the amber aim dot, and the hole/ball markers. Port
/// of the web `putt-overlay.ts` `puttLayers()` styling, extended with sparse
/// path stations; the dense fall-line field remains in the analysis overlay.
///
/// Unlike `GreenAnalysisRenderer` (wholesale rebuild — its states change
/// rarely), this renderer creates its sources/layers once and then only
/// reassigns `MLNShapeSource.shape` — the overlay updates on every marker
/// drag frame, and shape reassignment is MapLibre's cheap data-update path.
///
/// Owned by `CourseMapView.Coordinator`; layers are inserted below the target
/// markers (and above the analysis layers, because it is applied after).
@MainActor
final class PuttOverlayRenderer {

    /// Sources/layers exist in the current style.
    private var installed = false
    /// The overlay currently materialized (skip no-op re-applies).
    private var rendered: PuttReadGeometry.PuttOverlay?
    private var stationLabelImageNames: [String] = []

    /// Web putt palette (`putt-overlay.ts`).
    private static let pathBlue = UIColor(
        red: 0x2f / 255.0, green: 0x7d / 255.0, blue: 0xf4 / 255.0, alpha: 1
    )
    private static let pathSoftAmber = UIColor(
        red: 0xea / 255.0, green: 0xb3 / 255.0, blue: 0x08 / 255.0, alpha: 1
    )
    private static let aimAmber = UIColor(
        red: 0xf5 / 255.0, green: 0xb3 / 255.0, blue: 0x01 / 255.0, alpha: 1
    )
    private static let darkGreen = UIColor(
        red: 0x14 / 255.0, green: 0x28 / 255.0, blue: 0x1c / 255.0, alpha: 1
    )

    /// The style was rebuilt/reloaded — everything previously added is gone.
    func styleDidReload() {
        installed = false
        rendered = nil
        stationLabelImageNames = []
    }

    /// Bring the style in sync with `overlay` (nil clears the shapes; the
    /// sources/layers stay installed for the next read).
    func apply(_ overlay: PuttReadGeometry.PuttOverlay?, to style: MLNStyle) {
        guard overlay != rendered || !installed else { return }
        if overlay != nil { install(in: style) }
        guard installed else {
            rendered = nil
            return
        }

        setShape(shapeForLine(overlay?.reference ?? []), sourceID: PuttOverlayMapIDs.refSource, in: style)
        setShape(shapeForLine(overlay?.path ?? []), sourceID: PuttOverlayMapIDs.pathSource, in: style)
        setShape(
            shapeForLines(overlay?.stations.flatMap(\.arrowStrokes) ?? []),
            sourceID: PuttOverlayMapIDs.stationArrowsSource,
            in: style
        )
        applyStationLabels(overlay?.stations ?? [], to: style)
        setShape(pointsShape(overlay), sourceID: PuttOverlayMapIDs.pointsSource, in: style)

        // Softened reads render the path amber instead of blue (web parity).
        if let pathLayer = style.layer(
            withIdentifier: PuttOverlayMapIDs.pathLayer
        ) as? MLNLineStyleLayer {
            pathLayer.lineColor = NSExpression(
                forConstantValue: overlay?.soft == true ? Self.pathSoftAmber : Self.pathBlue
            )
        }
        rendered = overlay
    }

    // MARK: - Shapes

    private func shapeForLine(_ points: [LatLon]) -> MLNShape {
        guard points.count >= 2 else { return MLNShapeCollectionFeature(shapes: []) }
        var coordinates = points.map(\.clCoordinate)
        return MLNPolylineFeature(coordinates: &coordinates, count: UInt(coordinates.count))
    }

    private func shapeForLines(_ lines: [[LatLon]]) -> MLNShape {
        let features = lines.compactMap { line -> MLNPolylineFeature? in
            guard line.count >= 2 else { return nil }
            var coordinates = line.map(\.clCoordinate)
            return MLNPolylineFeature(coordinates: &coordinates, count: UInt(coordinates.count))
        }
        return MLNShapeCollectionFeature(shapes: features)
    }

    private func applyStationLabels(
        _ stations: [PuttReadGeometry.PuttOverlay.Station],
        to style: MLNStyle
    ) {
        let names = stations.indices.map { "\(PuttOverlayMapIDs.stationLabelImagePrefix)\($0)" }
        for oldName in stationLabelImageNames where !names.contains(oldName) {
            style.removeImage(forName: oldName)
        }

        let features = stations.enumerated().map { index, station -> MLNPointFeature in
            let name = names[index]
            let text = String(format: "%.1f%%", station.slopePct)
            style.setImage(GreenAnalysisRenderer.labelImage(text: text), forName: name)
            let feature = MLNPointFeature()
            feature.coordinate = station.labelPosition.clCoordinate
            feature.attributes = ["labelImage": name]
            return feature
        }
        stationLabelImageNames = names
        setShape(
            MLNShapeCollectionFeature(shapes: features),
            sourceID: PuttOverlayMapIDs.stationLabelsSource,
            in: style
        )
    }

    private func pointsShape(_ overlay: PuttReadGeometry.PuttOverlay?) -> MLNShape {
        var features: [MLNPointFeature] = []
        func add(_ position: LatLon?, kind: String) {
            guard let position else { return }
            let feature = MLNPointFeature()
            feature.coordinate = position.clCoordinate
            feature.attributes = ["kind": kind]
            features.append(feature)
        }
        add(overlay?.aim, kind: "aim")
        add(overlay?.hole, kind: "hole")
        add(overlay?.ball, kind: "ball")
        return MLNShapeCollectionFeature(shapes: features)
    }

    private func setShape(_ shape: MLNShape, sourceID: String, in style: MLNStyle) {
        guard let source = style.source(withIdentifier: sourceID) as? MLNShapeSource else { return }
        source.shape = shape
    }

    // MARK: - Install (once per style)

    private func install(in style: MLNStyle) {
        guard !installed else { return }

        let empty = MLNShapeCollectionFeature(shapes: [])
        let refSource = MLNShapeSource(identifier: PuttOverlayMapIDs.refSource, shape: empty)
        let pathSource = MLNShapeSource(identifier: PuttOverlayMapIDs.pathSource, shape: empty)
        let stationArrowsSource = MLNShapeSource(
            identifier: PuttOverlayMapIDs.stationArrowsSource, shape: empty
        )
        let stationLabelsSource = MLNShapeSource(
            identifier: PuttOverlayMapIDs.stationLabelsSource, shape: empty
        )
        let pointsSource = MLNShapeSource(identifier: PuttOverlayMapIDs.pointsSource, shape: empty)
        style.addSource(refSource)
        style.addSource(pathSource)
        style.addSource(stationArrowsSource)
        style.addSource(stationLabelsSource)
        style.addSource(pointsSource)

        // Straight ball→hole reference — quiet dashed baseline for the break.
        let ref = MLNLineStyleLayer(identifier: PuttOverlayMapIDs.refLayer, source: refSource)
        ref.lineColor = NSExpression(forConstantValue: UIColor.white)
        ref.lineWidth = NSExpression(forConstantValue: 1)
        ref.lineOpacity = NSExpression(forConstantValue: 0.55)
        ref.lineDashPattern = NSExpression(forConstantValue: [2, 2])
        insert(ref, into: style)

        // Simulated break path — the read.
        let round = NSValue(mlnLineCap: .round)
        let casing = MLNLineStyleLayer(
            identifier: PuttOverlayMapIDs.pathCasingLayer, source: pathSource
        )
        casing.lineCap = NSExpression(forConstantValue: round)
        casing.lineJoin = NSExpression(forConstantValue: NSValue(mlnLineJoin: .round))
        casing.lineColor = NSExpression(forConstantValue: UIColor.white)
        casing.lineWidth = NSExpression(forConstantValue: 4.5)
        casing.lineOpacity = NSExpression(forConstantValue: 0.9)
        insert(casing, into: style)

        let path = MLNLineStyleLayer(identifier: PuttOverlayMapIDs.pathLayer, source: pathSource)
        path.lineCap = NSExpression(forConstantValue: round)
        path.lineJoin = NSExpression(forConstantValue: NSValue(mlnLineJoin: .round))
        path.lineColor = NSExpression(forConstantValue: Self.pathBlue)
        path.lineWidth = NSExpression(forConstantValue: 2.2)
        insert(path, into: style)

        // Local slope station: a one-meter fall-line arrow with a dark casing,
        // plus a slope-% chip just uphill of the station anchor.
        let stationCasing = MLNLineStyleLayer(
            identifier: PuttOverlayMapIDs.stationArrowsCasingLayer,
            source: stationArrowsSource
        )
        stationCasing.lineCap = NSExpression(forConstantValue: round)
        stationCasing.lineJoin = NSExpression(
            forConstantValue: NSValue(mlnLineJoin: .round)
        )
        stationCasing.lineColor = NSExpression(forConstantValue: Self.darkGreen)
        stationCasing.lineWidth = NSExpression(forConstantValue: 4)
        insert(stationCasing, into: style)

        let stationLine = MLNLineStyleLayer(
            identifier: PuttOverlayMapIDs.stationArrowsLineLayer,
            source: stationArrowsSource
        )
        stationLine.lineCap = NSExpression(forConstantValue: round)
        stationLine.lineJoin = NSExpression(
            forConstantValue: NSValue(mlnLineJoin: .round)
        )
        stationLine.lineColor = NSExpression(forConstantValue: UIColor.white)
        stationLine.lineWidth = NSExpression(forConstantValue: 2)
        insert(stationLine, into: style)

        let stationLabels = MLNSymbolStyleLayer(
            identifier: PuttOverlayMapIDs.stationLabelsLayer,
            source: stationLabelsSource
        )
        stationLabels.iconImageName = NSExpression(forKeyPath: "labelImage")
        stationLabels.iconAllowsOverlap = NSExpression(forConstantValue: true)
        stationLabels.iconIgnoresPlacement = NSExpression(forConstantValue: true)
        insert(stationLabels, into: style)

        // Aim dot / hole / ball circles (web palette + sizes).
        insert(circleLayer(
            id: PuttOverlayMapIDs.aimLayer, source: pointsSource, kind: "aim",
            radius: 4, fill: Self.aimAmber, stroke: Self.darkGreen
        ), into: style)
        insert(circleLayer(
            id: PuttOverlayMapIDs.holeLayer, source: pointsSource, kind: "hole",
            radius: 4.5, fill: Self.darkGreen, stroke: .white
        ), into: style)
        insert(circleLayer(
            id: PuttOverlayMapIDs.ballLayer, source: pointsSource, kind: "ball",
            radius: 5.5, fill: .white, stroke: Self.darkGreen
        ), into: style)

        installed = true
    }

    private func circleLayer(
        id: String,
        source: MLNSource,
        kind: String,
        radius: Double,
        fill: UIColor,
        stroke: UIColor
    ) -> MLNCircleStyleLayer {
        let layer = MLNCircleStyleLayer(identifier: id, source: source)
        layer.predicate = NSPredicate(format: "kind == %@", kind)
        layer.circleRadius = NSExpression(forConstantValue: radius)
        layer.circleColor = NSExpression(forConstantValue: fill)
        layer.circleStrokeColor = NSExpression(forConstantValue: stroke)
        layer.circleStrokeWidth = NSExpression(forConstantValue: 1.5)
        return layer
    }

    /// Putt layers sit below the dynamic target/user markers, like the
    /// analysis layers — and above them, because this renderer applies after
    /// `GreenAnalysisRenderer` (insertion below the same anchor stacks later
    /// layers on top of earlier ones).
    private func insert(_ layer: MLNStyleLayer, into style: MLNStyle) {
        if let targets = style.layer(withIdentifier: MapStyleIDs.targetsLayer) {
            style.insertLayer(layer, below: targets)
        } else {
            style.addLayer(layer)
        }
    }
}
