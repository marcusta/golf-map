import XCTest
@testable import GolfMap

/// D-HF3 — the pure two-anchor hole-entry camera solve: known origin/aim/
/// viewport geometry to center/zoom/bearing, the zoom-clamp branch (origin
/// anchor holds), the dispersion-margin branch, and the latitude dependence
/// of the zoom↔meters-per-point conversion.
final class AnchoredCameraSolveTests: XCTestCase {

    private let origin = LatLon(lat: 58.3600, lon: 15.7100)

    /// A point `east`/`north` planar meters (SWEREF) from the origin.
    private func offset(from base: LatLon, east: Double, north: Double) -> LatLon {
        let p = Sweref99TM.fromWGS84(base)
        return Sweref99TM.toWGS84(x: p.x + east, y: p.y + north)
    }

    /// The default fixture: 390×844 pt viewport, header (60) + card (260)
    /// chrome, reticle anchor 30% of the FULL height, ball anchor 78% of the
    /// usable height. Usable height 524 → aim y 253.2, origin y 468.72,
    /// anchor separation 215.52 pt; usable width 374.
    private func input(
        aim: LatLon,
        insetTop: Double = 60,
        insetBottom: Double = 260,
        minZoom: Double = 0,
        maxZoom: Double = 22,
        originAnchorYFraction: Double = AnchoredCameraSolve.originAnchorYFraction,
        dispersionHalfWidthM: Double = 0
    ) -> AnchoredCameraSolve.Input {
        AnchoredCameraSolve.Input(
            origin: origin,
            aim: aim,
            viewportWidth: 390,
            viewportHeight: 844,
            insets: MapEdgeInsets(top: insetTop, left: 8, bottom: insetBottom, right: 8),
            aimAnchorYFraction: 0.30,
            originAnchorYFraction: originAnchorYFraction,
            minZoom: minZoom,
            maxZoom: maxZoom,
            dispersionHalfWidthM: dispersionHalfWidthM
        )
    }

    /// Anchor separation for the default fixture, points.
    private let anchorSeparation = (60.0 + 0.78 * 524.0) - 844.0 * 0.30
    /// Origin-anchor offset below the viewport center, points (468.72 − 422).
    private let originAnchorBelowCenter = (60.0 + 0.78 * 524.0) - 844.0 / 2

    // MARK: - Conversion helpers

    func testMetersPerPointMatchesWebMercatorAtEquator() {
        // 40075016.68557849 / (512 · 2^15) hand-computed.
        XCTAssertEqual(
            AnchoredCameraSolve.metersPerPoint(zoom: 15, latitude: 0),
            2.3886571, accuracy: 1e-4
        )
    }

    func testZoomAndMetersPerPointAreInverses() {
        let zoom = AnchoredCameraSolve.zoom(forMetersPerPoint: 1.25, latitude: 58.36)
        XCTAssertEqual(
            AnchoredCameraSolve.metersPerPoint(zoom: zoom, latitude: 58.36),
            1.25, accuracy: 1e-9
        )
    }

    // MARK: - Pure solve

    func testSolvePlacesOriginAndAimOnTheirAnchors() throws {
        let aim = offset(from: origin, east: 0, north: 300)
        let solution = try XCTUnwrap(AnchoredCameraSolve.solve(input(aim: aim)))

        // First-shot-up: grid-north aim → bearing 0.
        XCTAssertEqual(solution.bearing, 0, accuracy: 0.01)

        // Zoom: the 300 m aim line spans exactly the anchor separation.
        let metersPerPoint = AnchoredCameraSolve.metersPerPoint(
            zoom: solution.zoom, latitude: origin.lat
        )
        XCTAssertEqual(300 / metersPerPoint, anchorSeparation, accuracy: 0.01,
                       "world distance / mpp = screen distance between anchors")

        // Center: the origin anchor sits 46.72 pt below the viewport center,
        // so the center is that many points' worth of meters up the bearing.
        let expectedOffsetM = originAnchorBelowCenter * metersPerPoint
        XCTAssertEqual(
            Distance.planarMeters(origin, solution.center), expectedOffsetM,
            accuracy: 0.05
        )
        // Due north of the origin (the bearing direction).
        let originPlanar = Sweref99TM.fromWGS84(origin)
        let centerPlanar = Sweref99TM.fromWGS84(solution.center)
        XCTAssertEqual(centerPlanar.x, originPlanar.x, accuracy: 0.05)
        XCTAssertGreaterThan(centerPlanar.y, originPlanar.y)
    }

    func testBearingFollowsTheAimDirection() throws {
        let east = try XCTUnwrap(
            AnchoredCameraSolve.solve(input(aim: offset(from: origin, east: 200, north: 0)))
        )
        XCTAssertEqual(east.bearing, 90, accuracy: 0.01)

        let southWest = try XCTUnwrap(
            AnchoredCameraSolve.solve(input(aim: offset(from: origin, east: -150, north: -150)))
        )
        XCTAssertEqual(southWest.bearing, 225, accuracy: 0.01)
    }

    // MARK: - Zoom clamps (origin anchor holds)

    func testMaxZoomClampHoldsTheOriginAnchor() throws {
        // 40 m par-3 chip: the pure solve would zoom well past 16.
        let aim = offset(from: origin, east: 0, north: 40)
        let unclamped = try XCTUnwrap(AnchoredCameraSolve.solve(input(aim: aim)))
        XCTAssertGreaterThan(unclamped.zoom, 16)

        let clamped = try XCTUnwrap(
            AnchoredCameraSolve.solve(input(aim: aim, maxZoom: 16))
        )
        XCTAssertEqual(clamped.zoom, 16, accuracy: 1e-9)

        // Origin anchor holds: center derived from the origin at the CLAMPED
        // scale — the aim drifts off its anchor instead.
        let metersPerPoint = AnchoredCameraSolve.metersPerPoint(zoom: 16, latitude: origin.lat)
        XCTAssertEqual(
            Distance.planarMeters(origin, clamped.center),
            originAnchorBelowCenter * metersPerPoint,
            accuracy: 0.05
        )
        XCTAssertLessThan(40 / metersPerPoint, anchorSeparation,
                          "the aim renders short of the reticle anchor when clamped in")
    }

    func testMinZoomClampHoldsTheOriginAnchor() throws {
        // 3 km monster: the pure solve lands near zoom 11.5.
        let aim = offset(from: origin, east: 0, north: 3000)
        let clamped = try XCTUnwrap(
            AnchoredCameraSolve.solve(input(aim: aim, minZoom: 13))
        )
        XCTAssertEqual(clamped.zoom, 13, accuracy: 1e-9)
        let metersPerPoint = AnchoredCameraSolve.metersPerPoint(zoom: 13, latitude: origin.lat)
        XCTAssertEqual(
            Distance.planarMeters(origin, clamped.center),
            originAnchorBelowCenter * metersPerPoint,
            accuracy: 0.1
        )
        XCTAssertGreaterThan(3000 / metersPerPoint, anchorSeparation,
                             "the aim renders past the reticle anchor when clamped out")
    }

    // MARK: - Dispersion margin

    func testDispersionMarginBacksZoomOffJustEnough() throws {
        let aim = offset(from: origin, east: 0, north: 150)
        let pure = try XCTUnwrap(AnchoredCameraSolve.solve(input(aim: aim)))

        // A 200 m half-width cannot fit the usable half (374/2 − 12 = 175 pt)
        // at the pure zoom — the solve backs off until it just fits.
        let widened = try XCTUnwrap(
            AnchoredCameraSolve.solve(input(aim: aim, dispersionHalfWidthM: 200))
        )
        XCTAssertLessThan(widened.zoom, pure.zoom)
        let metersPerPoint = AnchoredCameraSolve.metersPerPoint(
            zoom: widened.zoom, latitude: origin.lat
        )
        XCTAssertEqual(200 / metersPerPoint, 374.0 / 2 - 12, accuracy: 0.01,
                       "backed off JUST enough to contain the ellipse laterally")
    }

    func testDispersionMarginNeverTightensTheFrame() throws {
        let aim = offset(from: origin, east: 0, north: 150)
        let pure = try XCTUnwrap(AnchoredCameraSolve.solve(input(aim: aim)))
        // A narrow ellipse already fits — the zoom must not change.
        let narrow = try XCTUnwrap(
            AnchoredCameraSolve.solve(input(aim: aim, dispersionHalfWidthM: 20))
        )
        XCTAssertEqual(narrow.zoom, pure.zoom, accuracy: 1e-9)
    }

    // MARK: - Latitude dependence

    func testZoomDependsOnLatitude() throws {
        // Identical planar geometry near the equator and in Sweden: the same
        // meters-per-point needs a LOWER zoom number at high latitude, offset
        // by exactly log2(cos φ_eq / cos φ_se) of the mercator scale factor.
        let equatorOrigin = LatLon(lat: 0.0005, lon: 15.7100)
        let sweden = try XCTUnwrap(
            AnchoredCameraSolve.solve(input(aim: offset(from: origin, east: 0, north: 300)))
        )
        var equatorInput = input(aim: offset(from: origin, east: 0, north: 300))
        equatorInput.origin = equatorOrigin
        equatorInput.aim = offset(from: equatorOrigin, east: 0, north: 300)
        let equator = try XCTUnwrap(AnchoredCameraSolve.solve(equatorInput))

        let expectedDelta = log2(
            cos(equatorOrigin.lat * .pi / 180) / cos(origin.lat * .pi / 180)
        )
        XCTAssertGreaterThan(equator.zoom, sweden.zoom)
        // SWEREF planar distances at the equator carry a little projection
        // distortion far from the true scale bands — allow it in the tolerance.
        XCTAssertEqual(equator.zoom - sweden.zoom, expectedDelta, accuracy: 0.01)
    }

    // MARK: - Degenerate input

    func testDegenerateInputsReturnNil() {
        XCTAssertNil(AnchoredCameraSolve.solve(input(aim: origin)),
                     "aim on the origin")
        XCTAssertNil(
            AnchoredCameraSolve.solve(
                input(aim: offset(from: origin, east: 0, north: 300), insetBottom: 900)
            ),
            "chrome swallows the usable viewport"
        )
        XCTAssertNil(
            AnchoredCameraSolve.solve(
                input(
                    aim: offset(from: origin, east: 0, north: 300),
                    originAnchorYFraction: 0.05
                )
            ),
            "origin anchor above the reticle anchor — no separation"
        )
        var zeroViewport = input(aim: offset(from: origin, east: 0, north: 300))
        zeroViewport.viewportWidth = 0
        zeroViewport.viewportHeight = 0
        XCTAssertNil(AnchoredCameraSolve.solve(zeroViewport), "no measured viewport")
    }
}
