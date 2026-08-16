import Foundation

/// D-HF3 — the two-anchor hole-entry camera solve (hole-select framing).
///
/// In pan-to-aim mode the reticle is screen-fixed, so "where the camera is"
/// and "what the reticle aims at" are the same decision. The hole-entry
/// camera is therefore SOLVED, not fitted: the origin (tee/ball) renders at
/// the origin anchor, the default aim at the reticle anchor, bearing is the
/// origin→aim direction (first-shot-up), and the zoom is uniquely determined
/// by the world distance divided by the anchors' screen separation. Never a
/// fit-bounds on the aim line — the green being off-screen on long holes is
/// correct (the chips carry that information; one pan up reveals it).
///
/// Adjustments on top of the pure solve, in order:
/// 1. Zoom clamps (min/max) — when clamped the ORIGIN anchor holds (the
///    center is always derived from it) and the aim drifts off its anchor.
/// 2. Dispersion margin — if the advised club's ellipse at the aim would
///    clip the usable viewport laterally, the zoom backs off just enough to
///    contain it.
///
/// Pure geometry (SWEREF planar for distance/bearing, web-mercator math for
/// the zoom↔meters-per-point conversion) so it unit-tests without a map.
public enum AnchoredCameraSolve {

    /// Ball/origin anchor: y as a fraction of the USABLE (chrome-inset-
    /// adjusted) viewport height — the tee/ball sits low on hole entry.
    public static let originAnchorYFraction = 0.78
    /// Lateral breathing room (points) kept between the dispersion ellipse
    /// and the usable viewport edges before the zoom backs off.
    public static let dispersionMarginPoints = 12.0

    public struct Input: Equatable {
        /// World origin (live fix / browse origin / active tee).
        public var origin: LatLon
        /// World default aim (D-HF1; green center by construction when no
        /// clamp/snap applies).
        public var aim: LatLon
        /// FULL map viewport in points (the map ignores the safe area).
        public var viewportWidth: Double
        public var viewportHeight: Double
        /// Chrome covering the viewport; usable viewport = viewport − insets.
        public var insets: MapEdgeInsets
        /// Reticle anchor y as a fraction of the FULL viewport height — the
        /// reticle draws there regardless of chrome
        /// (`CourseMapView.Coordinator.reticleAnchorYFraction`).
        public var aimAnchorYFraction: Double
        /// Origin anchor y as a fraction of the USABLE viewport height.
        public var originAnchorYFraction: Double
        public var minZoom: Double
        public var maxZoom: Double
        /// Advised club's lateral dispersion HALF-width at the aim, meters.
        /// 0 = no dispersion margin (competition mode / empty bag).
        public var dispersionHalfWidthM: Double

        public init(
            origin: LatLon,
            aim: LatLon,
            viewportWidth: Double,
            viewportHeight: Double,
            insets: MapEdgeInsets = .zero,
            aimAnchorYFraction: Double,
            originAnchorYFraction: Double = AnchoredCameraSolve.originAnchorYFraction,
            minZoom: Double,
            maxZoom: Double,
            dispersionHalfWidthM: Double = 0
        ) {
            self.origin = origin
            self.aim = aim
            self.viewportWidth = viewportWidth
            self.viewportHeight = viewportHeight
            self.insets = insets
            self.aimAnchorYFraction = aimAnchorYFraction
            self.originAnchorYFraction = originAnchorYFraction
            self.minZoom = minZoom
            self.maxZoom = maxZoom
            self.dispersionHalfWidthM = dispersionHalfWidthM
        }
    }

    public struct Solution: Equatable {
        /// World point rendered at the (full) viewport center.
        public var center: LatLon
        public var zoom: Double
        /// Degrees clockwise from north; up-screen = origin→aim.
        public var bearing: Double
    }

    /// Web-mercator world circumference at the equator, meters (2π·6378137 —
    /// the constant MapLibre's zoom scale is built on).
    static let webMercatorCircumferenceM = 40_075_016.685_578_49
    /// MapLibre's style tile size in points: zoom z shows the whole world in
    /// 512·2^z points.
    static let tileSizePoints = 512.0

    /// Ground meters per screen point at `zoom`, web mercator at `latitude`
    /// (mirrors `MLNMapView.metersPerPoint(atLatitude:)`). The latitude term
    /// is why the solve is latitude-dependent: one zoom level covers fewer
    /// ground meters per point the farther from the equator.
    public static func metersPerPoint(zoom: Double, latitude: Double) -> Double {
        webMercatorCircumferenceM * cos(latitude * .pi / 180)
            / (tileSizePoints * pow(2, zoom))
    }

    /// Zoom whose meters-per-point at `latitude` equals `metersPerPoint`.
    public static func zoom(forMetersPerPoint metersPerPoint: Double, latitude: Double) -> Double {
        log2(
            webMercatorCircumferenceM * cos(latitude * .pi / 180)
                / (tileSizePoints * metersPerPoint)
        )
    }

    /// Solves center+zoom+bearing so the origin sits at the origin anchor and
    /// the aim at the reticle anchor. Nil on degenerate input (no viewport,
    /// chrome swallowing the usable viewport, aim on the origin, anchors not
    /// separated) — callers fall back to the plain hole fit.
    public static func solve(_ input: Input) -> Solution? {
        let width = input.viewportWidth
        let height = input.viewportHeight
        guard width > 0, height > 0 else { return nil }
        let usableHeight = height - input.insets.top - input.insets.bottom
        let usableWidth = width - input.insets.left - input.insets.right
        guard usableHeight > 0, usableWidth > 0 else { return nil }

        let o = Sweref99TM.fromWGS84(input.origin)
        let a = Sweref99TM.fromWGS84(input.aim)
        let east = a.x - o.x
        let north = a.y - o.y
        let distanceM = hypot(east, north)
        guard distanceM > 0.5 else { return nil }
        var bearing = atan2(east, north) * 180 / .pi
        if bearing < 0 { bearing += 360 }

        // Anchor screen positions (full-viewport coordinates, y down). The
        // aim anchor is the reticle's — a FULL-viewport fraction, exactly
        // where the crosshair draws; the origin anchor sits inside the
        // usable (chrome-inset-adjusted) viewport.
        let aimY = height * input.aimAnchorYFraction
        let originY = input.insets.top + usableHeight * input.originAnchorYFraction
        let anchorSeparation = originY - aimY
        guard anchorSeparation > 0 else { return nil }

        // Zoom: world distance / anchor separation, converted at the
        // origin's latitude (a hole is far too short for the latitude to
        // change meaningfully across it).
        let latitude = input.origin.lat
        var zoom = Self.zoom(
            forMetersPerPoint: distanceM / anchorSeparation, latitude: latitude
        )

        // (1) Zoom clamps. The origin anchor holds (center derivation below
        // starts from it); the aim drifts from its anchor when clamped.
        zoom = min(max(zoom, input.minZoom), input.maxZoom)

        // (2) Dispersion margin: back the zoom off just enough that the
        // ellipse's half-width fits inside the usable half-width less the
        // margin. Zoom-out only — it never tightens the frame.
        if input.dispersionHalfWidthM > 0 {
            let availableHalfPoints = usableWidth / 2 - dispersionMarginPoints
            if availableHalfPoints > 0 {
                let cap = Self.zoom(
                    forMetersPerPoint: input.dispersionHalfWidthM / availableHalfPoints,
                    latitude: latitude
                )
                if zoom > cap { zoom = max(input.minZoom, cap) }
            }
        }

        // Center: the world point rendered at the viewport center. The
        // origin holds its anchor, the viewport center sits
        // `originY − height/2` points up-screen of it, and with the map
        // rotated to `bearing` up-screen IS the origin→aim direction.
        let metersPerPoint = Self.metersPerPoint(zoom: zoom, latitude: latitude)
        let offsetM = (originY - height / 2) * metersPerPoint
        let radians = bearing * .pi / 180
        let center = Sweref99TM.toWGS84(
            x: o.x + sin(radians) * offsetM,
            y: o.y + cos(radians) * offsetM
        )
        return Solution(center: center, zoom: zoom, bearing: bearing)
    }
}
