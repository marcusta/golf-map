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

    /// Labels last applied — re-anchored against the live viewport whenever the
    /// camera moves (see `reposition`).
    private var lastLabels: [RouteLegLabel] = []
    /// Style-image names currently registered.
    private var registeredImageNames: Set<String> = []

    /// The style was rebuilt/reloaded — sources reset, registered images gone.
    func styleDidReload() {
        lastLabels = []
        registeredImageNames = []
    }

    /// Bring the style in sync with `labels` (empty hides the layer's data) and
    /// place each at its in-view anchor for the current viewport.
    func apply(_ labels: [RouteLegLabel], to mapView: MLNMapView) {
        guard let style = mapView.style else { return }

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

        lastLabels = labels
        rebuildShape(in: mapView)
    }

    /// Re-anchor the current labels against the live viewport — called as the
    /// camera moves so a label whose midpoint scrolls off-screen is pulled onto
    /// the visible part of its leg (and one whose leg leaves the screen hides).
    func reposition(in mapView: MLNMapView) {
        guard mapView.style != nil else { return }
        rebuildShape(in: mapView)
    }

    private func rebuildShape(in mapView: MLNMapView) {
        guard let source = mapView.style?.source(
            withIdentifier: MapStyleIDs.routeLegLabelsSource
        ) as? MLNShapeSource else { return }
        let visible = Self.visibleRect(for: mapView)
        let features = lastLabels.compactMap { label -> MLNPointFeature? in
            guard let anchor = Self.anchor(for: label, in: mapView, visible: visible) else {
                return nil
            }
            let feature = MLNPointFeature()
            feature.coordinate = anchor
            feature.attributes = ["labelImage": Self.imageName(meters: label.meters)]
            return feature
        }
        source.shape = MLNShapeCollectionFeature(shapes: features)
    }

    // MARK: - Viewport anchoring (keep the label on the visible part of the leg)

    /// The rect a label must stay inside, inset from the map edges to clear the
    /// top hole bar / compact chip and the bottom tool panel (and the label's
    /// own `icon-offset` on the right).
    static func visibleRect(for mapView: MLNMapView) -> CGRect {
        mapView.bounds.inset(by: UIEdgeInsets(top: 96, left: 24, bottom: 140, right: 44))
    }

    /// In-view anchor for a label: its midpoint when that is inside `visible`
    /// (the default, unchanged placement); otherwise the midpoint of the leg's
    /// visible (clipped) portion, pulling the number into view. nil when no
    /// part of the leg is visible.
    static func anchor(
        for label: RouteLegLabel, in mapView: MLNMapView, visible: CGRect
    ) -> CLLocationCoordinate2D? {
        let mid = mapView.convert(label.midpoint.clCoordinate, toPointTo: mapView)
        if visible.contains(mid) { return label.midpoint.clCoordinate }
        let p0 = mapView.convert(label.start.clCoordinate, toPointTo: mapView)
        let p1 = mapView.convert(label.end.clCoordinate, toPointTo: mapView)
        guard let (t0, t1) = clipSegment(p0, p1, to: visible) else { return nil }
        let t = (t0 + t1) / 2
        let point = CGPoint(x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t)
        return mapView.convert(point, toCoordinateFrom: mapView)
    }

    /// Liang–Barsky segment clip. Returns the entry/exit parameters (0…1 along
    /// p0→p1) of the portion inside `rect`, or nil if the segment misses it.
    static func clipSegment(
        _ p0: CGPoint, _ p1: CGPoint, to rect: CGRect
    ) -> (CGFloat, CGFloat)? {
        let dx = p1.x - p0.x, dy = p1.y - p0.y
        var t0: CGFloat = 0, t1: CGFloat = 1
        let p = [-dx, dx, -dy, dy]
        let q = [p0.x - rect.minX, rect.maxX - p0.x, p0.y - rect.minY, rect.maxY - p0.y]
        for i in 0..<4 {
            if p[i] == 0 {
                if q[i] < 0 { return nil } // parallel to this edge and outside
            } else {
                let r = q[i] / p[i]
                if p[i] < 0 {
                    if r > t1 { return nil }
                    if r > t0 { t0 = r }
                } else {
                    if r < t0 { return nil }
                    if r < t1 { t1 = r }
                }
            }
        }
        return (t0, t1)
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
        // 20% larger than the original 16 pt for on-course legibility.
        textImage("\(meters)", fontSize: 19.2)
    }

    /// The shared white-on-stroke text rasterizer behind `labelImage` — also
    /// used by `EllipseLabelRenderer` so every on-map text image (route-leg
    /// figures, ellipse labels) shares one look.
    static func textImage(_ string: String, fontSize: CGFloat) -> UIImage {
        let text = string as NSString
        let baseFont = UIFont.systemFont(ofSize: fontSize, weight: .bold)
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
