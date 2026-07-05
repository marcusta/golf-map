import Foundation
import MapLibre
import UIKit

/// Renders the Adjust-mode draggable handles: one kind-colored ring per
/// element (tee / aim point / green center) with its short label ("T", "A1",
/// "G") centered on the ring.
///
/// The offline course style has no glyph PBFs, so a symbol layer's
/// `text-field` cannot render text. Like the route-leg distance labels
/// (`RouteLegLabelRenderer`), every distinct label is pre-rendered as a small
/// `UIImage`, registered via `style.setImage(_:forName:)`, and placed through
/// the `overlay-adjust-handles-label` symbol layer's data-driven `icon-image`.
/// The ring itself is the plain `overlay-adjust-handles-circle` layer fed from
/// the same source (source + layers are part of `MapStyleBuilder`'s JSON —
/// only image registration + shape updates happen at runtime).
///
/// Stateful (owned by `CourseMapView.Coordinator`): images are cached per
/// label text; a drag that only moves positions re-uses every image. An
/// equality guard skips all work when nothing changed.
@MainActor
final class AdjustHandleRenderer {

    static let imageNamePrefix = "adjust-handle-label-"

    /// Handles currently materialized in the style (skip-work guard).
    private var rendered: [AdjustHandle]?
    /// Style-image names currently registered.
    private var registeredImageNames: Set<String> = []

    /// The style was rebuilt/reloaded — sources reset, registered images gone.
    func styleDidReload() {
        rendered = nil
        registeredImageNames = []
    }

    /// Bring the style in sync with `handles` (empty hides the layer's data).
    func apply(_ handles: [AdjustHandle], to style: MLNStyle) {
        guard handles != rendered else { return }

        // Register images for new labels BEFORE the features referencing them
        // reach the source; drop labels no longer shown.
        let needed = Set(handles.map { Self.imageName(label: $0.label) })
        for stale in registeredImageNames.subtracting(needed) {
            style.removeImage(forName: stale)
        }
        registeredImageNames.formIntersection(needed)
        for handle in handles {
            let name = Self.imageName(label: handle.label)
            if registeredImageNames.insert(name).inserted {
                style.setImage(Self.labelImage(label: handle.label), forName: name)
            }
        }

        guard
            let source = style.source(
                withIdentifier: MapStyleIDs.adjustHandlesSource
            ) as? MLNShapeSource
        else {
            assertionFailure("Adjust-handle source missing from style")
            return
        }
        source.shape = Self.shape(handles)
        rendered = handles
    }

    // MARK: - Pure builders (unit-tested)

    /// Image id for a label text. Text-keyed so identical labels (never on one
    /// hole, but harmless) share one registered image.
    static func imageName(label: String) -> String {
        "\(imageNamePrefix)\(label)"
    }

    /// One point feature per handle: `kind` drives the circle layer's
    /// data-driven ring color, `labelImage` the symbol layer's icon.
    static func shape(_ handles: [AdjustHandle]) -> MLNShape {
        let features = handles.map { handle -> MLNPointFeature in
            let feature = MLNPointFeature()
            feature.coordinate = handle.position.clCoordinate
            feature.attributes = [
                "kind": handle.kind.rawValue,
                "labelImage": imageName(label: handle.label),
            ]
            return feature
        }
        return MLNShapeCollectionFeature(shapes: features)
    }

    /// Bold white rounded label with a thin dark stroke — same treatment as
    /// the route-leg numbers so it reads on both the ring fill and the ortho.
    static func labelImage(label: String) -> UIImage {
        let text = label as NSString
        let baseFont = UIFont.systemFont(ofSize: 13, weight: .bold)
        let font = baseFont.fontDescriptor.withDesign(.rounded)
            .map { UIFont(descriptor: $0, size: baseFont.pointSize) } ?? baseFont

        // Stroke-only pass behind a plain fill pass so the outline never eats
        // into the white glyph core (see RouteLegLabelRenderer).
        let strokeAttributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .strokeColor: UIColor(white: 0.05, alpha: 0.9),
            .strokeWidth: 8.0,
        ]
        let fillAttributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor.white,
        ]

        let textSize = text.size(withAttributes: fillAttributes)
        let inset: CGFloat = 3
        let size = CGSize(
            width: ceil(textSize.width) + inset * 2,
            height: ceil(textSize.height) + inset * 2
        )
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { _ in
            let origin = CGPoint(x: inset, y: inset)
            text.draw(at: origin, withAttributes: strokeAttributes)
            text.draw(at: origin, withAttributes: fillAttributes)
        }
    }
}
