import SwiftUI

/// The mini green map: the phone-pre-rendered slope shading of the current
/// hole's green (same ramp as the phone/web Green view), with the green
/// boundary and the player's live position composited on top, plus the
/// front/center/back distances. North-up. The watch computes nothing — it
/// draws a bitmap.
struct GreenMapView: View {
    @Bindable var tracker: ShotTracker
    let course: WatchCourseBundle
    let selector: HoleSelector

    /// How far off the image extent the player dot still draws (clamped to
    /// the edge would lie; slightly outside is honest and useful).
    private static let dotMarginM = 25.0

    private var hole: WatchHole? {
        course.holes.indices.contains(selector.currentIndex)
            ? course.holes[selector.currentIndex] : nil
    }

    var body: some View {
        VStack(spacing: 2) {
            header
            greenCanvas
            distancesRow
        }
        .padding(.horizontal, 4)
    }

    private var header: some View {
        HStack {
            if let hole {
                Text("Hole \(hole.number)")
                    .font(.headline)
            }
            Spacer()
            Text("GREEN")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var greenCanvas: some View {
        if let hole, let image = hole.greenImage, let decoded = UIImage(data: image.png) {
            Canvas { context, size in
                let widthM = Double(image.widthPx) * image.metersPerPixel
                let heightM = Double(image.heightPx) * image.metersPerPixel
                guard widthM > 0, heightM > 0 else { return }
                let scale = min(size.width / widthM, size.height / heightM)
                let offsetX = (size.width - widthM * scale) / 2
                let offsetY = (size.height - heightM * scale) / 2

                func point(_ p: Sweref99TM.Point) -> CGPoint {
                    CGPoint(
                        x: offsetX + (p.x - image.originE) * scale,
                        y: offsetY + (image.originN - p.y) * scale
                    )
                }

                context.draw(
                    Image(uiImage: decoded),
                    in: CGRect(
                        x: offsetX, y: offsetY,
                        width: widthM * scale, height: heightM * scale
                    )
                )

                if let ring = hole.greenPolygon {
                    let points = ring.compactMap { pair -> CGPoint? in
                        guard pair.count >= 2 else { return nil }
                        return point(Sweref99TM.fromWGS84(LatLon(lat: pair[0], lon: pair[1])))
                    }
                    if let first = points.first, points.count >= 3 {
                        var path = Path()
                        path.move(to: first)
                        for p in points.dropFirst() { path.addLine(to: p) }
                        path.closeSubpath()
                        context.stroke(path, with: .color(.white.opacity(0.9)), lineWidth: 1.5)
                    }
                }

                if let fix = tracker.currentFix {
                    let p = Sweref99TM.fromWGS84(
                        LatLon(lat: fix.coordinate.latitude, lon: fix.coordinate.longitude)
                    )
                    let margin = Self.dotMarginM
                    if p.x > image.originE - margin, p.x < image.originE + widthM + margin,
                       p.y < image.originN + margin, p.y > image.originN - heightM - margin {
                        let center = point(p)
                        let dot = CGRect(
                            x: center.x - 4, y: center.y - 4, width: 8, height: 8
                        )
                        context.fill(Path(ellipseIn: dot), with: .color(.blue))
                        context.stroke(Path(ellipseIn: dot), with: .color(.white), lineWidth: 1.5)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 4) {
                Image(systemName: "map")
                    .foregroundStyle(.secondary)
                Text("No green map")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var distancesRow: some View {
        if let fix = tracker.currentFix, let hole, let center = hole.greenCenterLatLon {
            let origin = LatLon(lat: fix.coordinate.latitude, lon: fix.coordinate.longitude)
            HStack(spacing: 10) {
                if let front = hole.greenFrontLatLon {
                    Text("F \(Int(Distance.planarMeters(origin, front).rounded()))")
                        .foregroundStyle(.secondary)
                }
                Text("C \(Int(Distance.planarMeters(origin, center).rounded()))")
                    .fontWeight(.semibold)
                if let back = hole.greenBackLatLon {
                    Text("B \(Int(Distance.planarMeters(origin, back).rounded()))")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.footnote)
            .monospacedDigit()
            .contentTransition(.numericText())
        }
    }
}
