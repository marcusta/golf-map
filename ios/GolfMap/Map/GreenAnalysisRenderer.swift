import Foundation
import MapLibre
import UIKit

/// Stable identifiers for the Green-view analysis layers (runtime-added on
/// top of the generated course style — never part of `MapStyleBuilder`'s
/// JSON, so entering/leaving Green view doesn't reload the style).
public enum GreenAnalysisMapIDs {
    public static let heatSource = "analysis-heat"
    public static let heatLayer = "analysis-heat"
    public static let boundarySource = "analysis-boundary"
    public static let boundaryCasingLayer = "analysis-boundary-casing"
    public static let boundaryCoreLayer = "analysis-boundary-core"
    public static let arrowsSource = "analysis-arrows"
    public static let arrowsCasingLayer = "analysis-arrows-casing"
    public static let arrowsLineLayer = "analysis-arrows-line"
    public static let labelsSource = "analysis-labels"
    public static let labelsLayer = "analysis-labels"
    static let labelImagePrefix = "analysis-label-"
}

/// Renders one `GreenAnalysisMapState` onto the course map: heat-map image
/// source (one pixel per grid cell) + raster layer, bold double green-
/// boundary outline, fall-line arrows (slope mode) and slope% labels.
///
/// Port of the web `AnalysisOverlayRenderer` (analysis-overlay.ts) with two
/// platform adaptations:
///  - the heat image goes through `MLNImageSource` + `MLNRasterStyleLayer`
///    instead of a canvas data URL;
///  - slope labels are pre-rendered text images on an `MLNSymbolStyleLayer`
///    (the offline style has no glyphs endpoint, so symbol TEXT cannot
///    render — the web hits the same wall and uses DOM markers).
///
/// Owned by `CourseMapView.Coordinator`; all analysis layers are inserted
/// below the target markers so F/C/B/pin stay visible over the heat map.
@MainActor
final class GreenAnalysisRenderer {

    /// The (result, mode) currently materialized in the style.
    private var rendered: GreenAnalysisMapState?
    private var labelImageNames: [String] = []

    /// The style was rebuilt/reloaded — everything previously added is gone.
    func styleDidReload() {
        rendered = nil
        labelImageNames = []
    }

    /// Bring the style in sync with `state` (nil clears). Rebuilds wholesale
    /// on change — changes are rare (mode toggle, new grid), and a full
    /// rebuild keeps the source/layer lifecycle trivially correct.
    func apply(_ state: GreenAnalysisMapState?, to style: MLNStyle) {
        guard state != rendered else { return }
        clear(from: style)
        guard let state else { return }

        addHeatLayer(state, to: style)
        addBoundary(state.result.boundaryRings, to: style)
        if state.mode == .slope {
            addArrows(state.result, to: style)
        }
        rendered = state
    }

    func clear(from style: MLNStyle) {
        for layerID in [
            GreenAnalysisMapIDs.labelsLayer,
            GreenAnalysisMapIDs.arrowsLineLayer,
            GreenAnalysisMapIDs.arrowsCasingLayer,
            GreenAnalysisMapIDs.boundaryCoreLayer,
            GreenAnalysisMapIDs.boundaryCasingLayer,
            GreenAnalysisMapIDs.heatLayer,
        ] {
            if let layer = style.layer(withIdentifier: layerID) {
                style.removeLayer(layer)
            }
        }
        for sourceID in [
            GreenAnalysisMapIDs.labelsSource,
            GreenAnalysisMapIDs.arrowsSource,
            GreenAnalysisMapIDs.boundarySource,
            GreenAnalysisMapIDs.heatSource,
        ] {
            if let source = style.source(withIdentifier: sourceID) {
                style.removeSource(source)
            }
        }
        for name in labelImageNames {
            style.removeImage(forName: name)
        }
        labelImageNames = []
        rendered = nil
    }

    // MARK: - Heat image

    private func addHeatLayer(_ state: GreenAnalysisMapState, to style: MLNStyle) {
        let grid = state.result.grid
        let rgba = buildOverlayRgba(
            grid,
            mode: state.mode,
            slope: state.result.slope,
            stats: state.result.stats
        )
        guard let image = Self.image(fromRGBA: rgba, width: grid.spec.width, height: grid.spec.height)
        else { return }

        let corners = AnalysisOverlayGeometry.gridCornerCoordinates(grid.spec)
        guard corners.count == 4 else { return }
        let quad = MLNCoordinateQuad(
            topLeft: corners[0].clCoordinate,
            bottomLeft: corners[3].clCoordinate,
            bottomRight: corners[2].clCoordinate,
            topRight: corners[1].clCoordinate
        )
        let source = MLNImageSource(
            identifier: GreenAnalysisMapIDs.heatSource,
            coordinateQuad: quad,
            image: image
        )
        style.addSource(source)

        let layer = MLNRasterStyleLayer(identifier: GreenAnalysisMapIDs.heatLayer, source: source)
        layer.rasterFadeDuration = NSExpression(forConstantValue: 0)
        insert(layer, into: style)
    }

    /// One pixel per grid cell, straight (non-premultiplied) alpha, row 0 =
    /// north — the same buffer layout as the web's canvas `ImageData`.
    static func image(fromRGBA rgba: [UInt8], width: Int, height: Int) -> UIImage? {
        guard width > 0, height > 0, rgba.count >= width * height * 4 else { return nil }
        let data = Data(rgba)
        guard
            let provider = CGDataProvider(data: data as CFData),
            let cgImage = CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: true,
                intent: .defaultIntent
            )
        else { return nil }
        return UIImage(cgImage: cgImage)
    }

    // MARK: - Boundary (bold double outline)

    private func addBoundary(_ rings: [[LatLon]], to style: MLNStyle) {
        let features = rings.filter { $0.count >= 2 }.map { ring -> MLNPolylineFeature in
            var coordinates = ring.map(\.clCoordinate)
            return MLNPolylineFeature(coordinates: &coordinates, count: UInt(coordinates.count))
        }
        guard !features.isEmpty else { return }
        let source = MLNShapeSource(
            identifier: GreenAnalysisMapIDs.boundarySource,
            shape: MLNShapeCollectionFeature(shapes: features)
        )
        style.addSource(source)

        let casing = MLNLineStyleLayer(
            identifier: GreenAnalysisMapIDs.boundaryCasingLayer,
            source: source
        )
        casing.lineColor = NSExpression(forConstantValue: UIColor.white)
        casing.lineWidth = NSExpression(forConstantValue: 5)
        casing.lineOpacity = NSExpression(forConstantValue: 0.95)
        insert(casing, into: style)

        let core = MLNLineStyleLayer(
            identifier: GreenAnalysisMapIDs.boundaryCoreLayer,
            source: source
        )
        core.lineColor = NSExpression(forConstantValue: UIColor(
            red: 0x14 / 255.0, green: 0x28 / 255.0, blue: 0x1c / 255.0, alpha: 1
        ))
        core.lineWidth = NSExpression(forConstantValue: 1.8)
        insert(core, into: style)
    }

    // MARK: - Fall-line arrows + labels (slope mode)

    private func addArrows(_ result: GreenAnalysisResult, to style: MLNStyle) {
        let lengthM = AnalysisOverlayGeometry.arrowLengthM(result.grid.spec)
        let arrows = AnalysisOverlayGeometry.arrowStrokes(result.arrows, lengthM: lengthM)
        guard !arrows.isEmpty else { return }

        let strokeFeatures = arrows.flatMap { arrow in
            arrow.strokes.map { stroke -> MLNPolylineFeature in
                var coordinates = stroke.map(\.clCoordinate)
                return MLNPolylineFeature(coordinates: &coordinates, count: UInt(coordinates.count))
            }
        }
        let source = MLNShapeSource(
            identifier: GreenAnalysisMapIDs.arrowsSource,
            shape: MLNShapeCollectionFeature(shapes: strokeFeatures)
        )
        style.addSource(source)

        let round = NSValue(mlnLineCap: .round)
        let casing = MLNLineStyleLayer(
            identifier: GreenAnalysisMapIDs.arrowsCasingLayer,
            source: source
        )
        casing.lineCap = NSExpression(forConstantValue: round)
        casing.lineColor = NSExpression(forConstantValue: UIColor(
            red: 0x14 / 255.0, green: 0x28 / 255.0, blue: 0x1c / 255.0, alpha: 1
        ))
        casing.lineWidth = NSExpression(forConstantValue: 3.5)
        casing.lineOpacity = NSExpression(forConstantValue: 0.5)
        insert(casing, into: style)

        let line = MLNLineStyleLayer(
            identifier: GreenAnalysisMapIDs.arrowsLineLayer,
            source: source
        )
        line.lineCap = NSExpression(forConstantValue: round)
        line.lineColor = NSExpression(forConstantValue: UIColor.white)
        line.lineWidth = NSExpression(forConstantValue: 1.6)
        insert(line, into: style)

        addLabels(for: arrows, to: style)
    }

    /// Slope% labels: every-4th arrow gets a pre-rendered text chip anchored
    /// one arrow-length downhill of the arrow (matching the web's DOM-marker
    /// placement).
    private func addLabels(for arrows: [AnalysisOverlayGeometry.ArrowStrokes], to style: MLNStyle) {
        var features: [MLNPointFeature] = []
        var names: [String] = []
        for (index, arrow) in arrows.enumerated() where arrow.labeled {
            let text = String(format: "%.1f", arrow.slopePct)
            let name = "\(GreenAnalysisMapIDs.labelImagePrefix)\(index)"
            style.setImage(Self.labelImage(text: text), forName: name)
            names.append(name)

            let feature = MLNPointFeature()
            feature.coordinate = arrow.labelPosition.clCoordinate
            feature.attributes = ["labelImage": name]
            features.append(feature)
        }
        labelImageNames = names
        guard !features.isEmpty else { return }

        let source = MLNShapeSource(
            identifier: GreenAnalysisMapIDs.labelsSource,
            shape: MLNShapeCollectionFeature(shapes: features)
        )
        style.addSource(source)

        let layer = MLNSymbolStyleLayer(identifier: GreenAnalysisMapIDs.labelsLayer, source: source)
        layer.iconImageName = NSExpression(forKeyPath: "labelImage")
        layer.iconAllowsOverlap = NSExpression(forConstantValue: true)
        insert(layer, into: style)
    }

    /// A small dark chip with the slope% figure, mirroring the web label CSS
    /// (rgba(10,20,14,0.75) bg, white 600 10px text, 4pt radius).
    static func labelImage(text: String) -> UIImage {
        let font = UIFont.systemFont(ofSize: 10, weight: .semibold)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor.white,
        ]
        let textSize = (text as NSString).size(withAttributes: attributes)
        let padding = CGSize(width: 4, height: 1.5)
        let size = CGSize(
            width: ceil(textSize.width) + padding.width * 2,
            height: ceil(textSize.height) + padding.height * 2
        )
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { context in
            let rect = CGRect(origin: .zero, size: size)
            let path = UIBezierPath(roundedRect: rect, cornerRadius: 4)
            UIColor(red: 10 / 255.0, green: 20 / 255.0, blue: 14 / 255.0, alpha: 0.75).setFill()
            path.fill()
            _ = context // silence unused warning paths
            (text as NSString).draw(
                at: CGPoint(x: padding.width, y: padding.height),
                withAttributes: attributes
            )
        }
    }

    // MARK: - Layer ordering

    /// Analysis layers sit above the course imagery but below the dynamic
    /// target/user markers, so F/C/B/pin and the GPS dot stay readable.
    private func insert(_ layer: MLNStyleLayer, into style: MLNStyle) {
        if let targets = style.layer(withIdentifier: MapStyleIDs.targetsLayer) {
            style.insertLayer(layer, below: targets)
        } else {
            style.addLayer(layer)
        }
    }
}
