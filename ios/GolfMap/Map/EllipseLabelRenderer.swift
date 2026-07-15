import Foundation
import MapLibre
import UIKit

/// Renders the on-map dispersion-ellipse labels: "<club> · <meters>" printed
/// at each visible ellipse's center (the selected-target advice ellipse and
/// the selection-scoped plan leg ellipses), so the two patterns on a green are
/// never anonymous.
///
/// Same wall/workaround as `RouteLegLabelRenderer`: the offline course style
/// has no glyph PBFs, so a symbol layer's `text-field` cannot render — each
/// distinct label string is pre-rendered as a small `UIImage`, registered via
/// `style.setImage(_:forName:)`, and placed through the
/// `overlay-ellipse-labels` symbol layer's data-driven `icon-image` (source +
/// layer are part of `MapStyleBuilder`'s JSON). Unlike the route-leg figures
/// these anchor at a fixed geo point (the ellipse center), so there is no
/// viewport re-anchoring pass.
///
/// Stateful (owned by `CourseMapView.Coordinator`): images are cached per
/// label string; strings that leave the screen are unregistered.
@MainActor
final class EllipseLabelRenderer {

    static let imageNamePrefix = "ellipse-label-"

    /// Style-image names currently registered.
    private var registeredImageNames: Set<String> = []

    /// The style was rebuilt/reloaded — registered images are gone.
    func styleDidReload() {
        registeredImageNames = []
    }

    /// Bring the style in sync with `labels` (empty hides the layer's data).
    func apply(_ labels: [EllipseLabel], to style: MLNStyle) {
        let needed = Set(labels.map { Self.imageName(text: $0.text) })
        for stale in registeredImageNames.subtracting(needed) {
            style.removeImage(forName: stale)
        }
        registeredImageNames.formIntersection(needed)
        for label in labels {
            let name = Self.imageName(text: label.text)
            if registeredImageNames.insert(name).inserted {
                style.setImage(Self.labelImage(text: label.text), forName: name)
            }
        }

        guard let source = style.source(
            withIdentifier: MapStyleIDs.ellipseLabelsSource
        ) as? MLNShapeSource else { return }
        source.shape = Self.shape(labels)
    }

    // MARK: - Pure builders (unit-tested)

    /// Image id for a label string. Value-keyed (not index-keyed) so equal
    /// labels share one registered image.
    static func imageName(text: String) -> String {
        "\(imageNamePrefix)\(text)"
    }

    /// One point feature per label, anchored at the ellipse center, carrying
    /// the image id the symbol layer's data-driven `icon-image` resolves.
    static func shape(_ labels: [EllipseLabel]) -> MLNShape {
        let features = labels.map { label -> MLNPointFeature in
            let feature = MLNPointFeature()
            feature.coordinate = label.position.clCoordinate
            feature.attributes = ["labelImage": imageName(text: label.text)]
            return feature
        }
        return MLNShapeCollectionFeature(shapes: features)
    }

    /// Slightly smaller than the route-leg figures — a caption on a shape, not
    /// a primary distance. Shares `RouteLegLabelRenderer`'s rasterizer so all
    /// on-map text images look alike.
    static func labelImage(text: String) -> UIImage {
        RouteLegLabelRenderer.textImage(text, fontSize: 14)
    }
}
