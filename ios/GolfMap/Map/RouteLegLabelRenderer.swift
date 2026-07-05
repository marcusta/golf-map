import Foundation
import MapLibre
import UIKit

/// Renders the immersive-mode route-leg distance labels: each leg's whole-
/// metre length printed at the leg's midpoint along the route line.
///
/// The offline course style has no glyph PBFs, so a symbol layer's
/// `text-field` cannot render text. Like the Green-view slope chips
/// (`GreenAnalysisRenderer`), every distinct metre value is pre-rendered as a
/// small `UIImage`, registered via `style.setImage(_:forName:)`, and placed
/// through the `overlay-route-leg-labels` symbol layer's data-driven
/// `icon-image` (source + layer are part of `MapStyleBuilder`'s JSON, so no
/// runtime layer lifecycle is needed — only image registration + shape
/// updates).
///
/// Stateful (owned by `CourseMapView.Coordinator`): images are cached per
/// metre value, so a GPS fix that changes only the first leg rasterizes one
/// tiny image and reuses the rest; values that leave the screen are
/// unregistered. An equality guard skips all work when nothing changed.
@MainActor
final class RouteLegLabelRenderer {

    static let imageNamePrefix = "route-leg-label-"

    /// Labels currently materialized in the style (skip-work guard).
    private var rendered: [RouteLegLabel]?
    /// Style-image names currently registered.
    private var registeredImageNames: Set<String> = []

    /// The style was rebuilt/reloaded — sources reset, registered images gone.
    func styleDidReload() {
        rendered = nil
        registeredImageNames = []
    }

    /// Bring the style in sync with `labels` (empty hides the layer's data).
    func apply(_ labels: [RouteLegLabel], to style: MLNStyle) {
        guard labels != rendered else { return }

        // Register images for new metre values BEFORE the features referencing
        // them reach the source; drop values no longer shown.
        let needed = Set(labels.map { Self.imageName(meters: $0.meters) })
        for stale in registeredImageNames.subtracting(needed) {
            style.removeImage(forName: stale)
        }
        registeredImageNames.formIntersection(needed)
        for label in labels {
            let name = Self.imageName(meters: label.meters)
            if registeredImageNames.insert(name).inserted {
                style.setImage(Self.labelImage(meters: label.meters), forName: name)
            }
        }

        guard
            let source = style.source(
                withIdentifier: MapStyleIDs.routeLegLabelsSource
            ) as? MLNShapeSource
        else {
            assertionFailure("Route-leg label source missing from style")
            return
        }
        source.shape = Self.shape(labels)
        rendered = labels
    }

    // MARK: - Pure builders (unit-tested)

    /// Image id for a metre value. Value-keyed (not index-keyed) so legs with
    /// the same length share one registered image.
    static func imageName(meters: Int) -> String {
        "\(imageNamePrefix)\(meters)"
    }

    /// One point feature per leg midpoint, carrying the image id the symbol
    /// layer's data-driven `icon-image` resolves.
    static func shape(_ labels: [RouteLegLabel]) -> MLNShape {
        let features = labels.map { label -> MLNPointFeature in
            let feature = MLNPointFeature()
            feature.coordinate = label.midpoint.clCoordinate
            feature.attributes = ["labelImage": imageName(meters: label.meters)]
            return feature
        }
        return MLNShapeCollectionFeature(shapes: features)
    }

    /// Bold white rounded numerals with a thin dark stroke and a soft shadow
    /// so the figure reads on both pale bunkers and dark fairway ortho — no
    /// pill background (clean numbers on the line, matching the card values).
    static func labelImage(meters: Int) -> UIImage {
        let text = "\(meters)" as NSString
        let baseFont = UIFont.systemFont(ofSize: 16, weight: .bold)
        let font = baseFont.fontDescriptor.withDesign(.rounded)
            .map { UIFont(descriptor: $0, size: baseFont.pointSize) } ?? baseFont

        // Two passes: a stroke-only pass behind a plain fill pass, so the
        // outline never eats into the white glyph core (a single negative
        // strokeWidth pass thins the numerals).
        let strokeAttributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .strokeColor: UIColor(white: 0.05, alpha: 0.9),
            .strokeWidth: 8.0, // percent of font size; positive = stroke only
        ]
        let fillAttributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor.white,
        ]

        let textSize = text.size(withAttributes: fillAttributes)
        let inset: CGFloat = 4 // room for the stroke + shadow blur
        let size = CGSize(
            width: ceil(textSize.width) + inset * 2,
            height: ceil(textSize.height) + inset * 2
        )
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { context in
            let origin = CGPoint(x: inset, y: inset)
            context.cgContext.setShadow(
                offset: CGSize(width: 0, height: 1),
                blur: 3,
                color: UIColor.black.withAlphaComponent(0.6).cgColor
            )
            text.draw(at: origin, withAttributes: strokeAttributes)
            context.cgContext.setShadow(offset: .zero, blur: 0, color: nil)
            text.draw(at: origin, withAttributes: fillAttributes)
        }
    }
}
