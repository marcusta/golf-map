import XCTest
@testable import GolfMap

/// Port of `web/tests/analysis-math.test.ts` — the Swift math must stay
/// numerically identical to the web implementation (same ramps, thresholds,
/// alphas, arrow heuristics).
final class AnalysisMathTests: XCTestCase {

    // MARK: - Fixtures

    /// Grid with heights from z(e, n) and an optional inside region.
    /// Mirrors the web `makeGrid` fixture (origin e=1000 n=2000, res 0.5).
    private func makeGrid(
        width: Int,
        height: Int,
        resolution: Double = 0.5,
        z: (Double, Double) -> Double,
        inside: ((Int, Int) -> Bool)? = nil
    ) -> SampleGrid {
        let spec = AnalysisGridSpec(
            originE: 1000, originN: 2000, resolution: resolution, width: width, height: height
        )
        var heights: [Double] = []
        var insideMask: [Bool] = []
        for row in 0..<height {
            for col in 0..<width {
                let e = spec.originE + (Double(col) + 0.5) * resolution
                let n = spec.originN - (Double(row) + 0.5) * resolution
                heights.append(z(e, n))
                insideMask.append(inside?(row, col) ?? true)
            }
        }
        return SampleGrid(spec: spec, heights: heights, insideMask: insideMask)
    }

    /// Tilted plane: dz/de = 0.03, dz/dn = 0.04 → slope 5%, downhill (−0.6, −0.8).
    private func planeGrid() -> SampleGrid {
        makeGrid(width: 12, height: 10) { e, n in
            50 + 0.03 * (e - 1000) + 0.04 * (n - 1990)
        }
    }

    // MARK: - computeSlopeGrid

    func testSlopeFromCentralDifferencesMatchesAnalyticPlaneEverywhere() {
        let grid = planeGrid()
        let slope = computeSlopeGrid(grid)
        // Central AND one-sided differences are exact on a plane — check all
        // cells including edges and corners.
        for i in 0..<grid.heights.count {
            XCTAssertEqual(slope.slopePct[i], 5, accuracy: 1e-8)
            XCTAssertEqual(slope.dirE[i], -0.6, accuracy: 1e-8)
            XCTAssertEqual(slope.dirN[i], -0.8, accuracy: 1e-8)
        }
    }

    func testSlopeIsZeroWithZeroDirectionOnFlatGrid() {
        let grid = makeGrid(width: 5, height: 5) { _, _ in 42 }
        let slope = computeSlopeGrid(grid)
        for i in 0..<25 {
            XCTAssertEqual(slope.slopePct[i], 0)
            XCTAssertEqual(slope.dirE[i], 0)
            XCTAssertEqual(slope.dirN[i], 0)
        }
    }

    func testDownhillDirectionPointsEastWhenHeightsFallToTheEast() {
        // z decreases with e → gradient east-negative → downhill = +east.
        let grid = makeGrid(width: 6, height: 4) { e, _ in 100 - 0.02 * (e - 1000) }
        let slope = computeSlopeGrid(grid)
        let i = 1 * 6 + 2
        XCTAssertEqual(slope.slopePct[i], 2, accuracy: 1e-8)
        XCTAssertEqual(slope.dirE[i], 1, accuracy: 1e-8)
        XCTAssertEqual(slope.dirN[i], 0, accuracy: 1e-8)
    }

    func testNodataCellsGetNaNSlopeAndNeighborsFallBackToOneSided() {
        var grid = planeGrid()
        let hole = 4 * grid.spec.width + 5
        grid.heights[hole] = .nan
        let slope = computeSlopeGrid(grid)
        XCTAssertTrue(slope.slopePct[hole].isNaN)
        // West neighbor of the hole: one-sided in e, still exact on a plane.
        XCTAssertEqual(slope.slopePct[hole - 1], 5, accuracy: 1e-8)
    }

    // MARK: - Color ramps (exact reference stops)

    func testSlopeRampHitsExactReferenceColorsAtThresholds() {
        XCTAssertEqual(slopeColor(0), SLOPE_BLUE)
        XCTAssertEqual(slopeColor(0.99), SLOPE_BLUE)
        XCTAssertEqual(slopeColor(1), SLOPE_BLUE)
        XCTAssertEqual(slopeColor(2), AnalysisRGB(51, 166, 153)) // blue→green midpoint
        XCTAssertEqual(slopeColor(2.9999), AnalysisRGB(51, 204, 51))
        XCTAssertEqual(slopeColor(3), SLOPE_GREEN)
        XCTAssertEqual(slopeColor(5), SLOPE_ORANGE)
        XCTAssertEqual(slopeColor(6), AnalysisRGB(255, 90, 90)) // orange→magenta midpoint
        XCTAssertEqual(slopeColor(7), SLOPE_MAGENTA)
        XCTAssertEqual(slopeColor(19), SLOPE_MAGENTA) // clamped
        XCTAssertEqual(slopeColor(.nan), SLOPE_BLUE)
    }

    func testHeightRampHitsExactFiveReferenceStops() {
        XCTAssertEqual(heightColor(0), HEIGHT_STOPS[0])
        XCTAssertEqual(heightColor(0.25), HEIGHT_STOPS[1])
        XCTAssertEqual(heightColor(0.5), HEIGHT_STOPS[2])
        XCTAssertEqual(heightColor(0.75), HEIGHT_STOPS[3])
        XCTAssertEqual(heightColor(1), HEIGHT_STOPS[4])
        XCTAssertEqual(heightColor(0.125), AnalysisRGB(0, 153, 153)) // blue→green midpoint
        XCTAssertEqual(heightColor(-1), HEIGHT_STOPS[0]) // clamped
        XCTAssertEqual(heightColor(2), HEIGHT_STOPS[4]) // clamped
    }

    func testRelativeRampNeutralAtGreenLevelPurpleAtDeepestRedAtHighest() {
        let scale = 1.5
        XCTAssertEqual(relativeColor(deltaM: 0, scaleM: scale), REL_NEUTRAL)
        XCTAssertEqual(relativeColor(deltaM: -scale, scaleM: scale), REL_BELOW_STOPS[3])
        XCTAssertEqual(relativeColor(deltaM: -scale / 3, scaleM: scale), REL_BELOW_STOPS[1])
        XCTAssertEqual(relativeColor(deltaM: -2 * scale / 3, scaleM: scale), REL_BELOW_STOPS[2])
        XCTAssertEqual(relativeColor(deltaM: scale, scaleM: scale), REL_ABOVE_STOPS[3])
        XCTAssertEqual(relativeColor(deltaM: scale / 3, scaleM: scale), REL_ABOVE_STOPS[1])
        XCTAssertEqual(relativeColor(deltaM: -10 * scale, scaleM: scale), REL_BELOW_STOPS[3])
        XCTAssertEqual(relativeColor(deltaM: 10 * scale, scaleM: scale), REL_ABOVE_STOPS[3])
    }

    // MARK: - Stats + relative normalization

    func testComputeStatsSeparatesGreenAndSurroundsAndFindsDeepestHollow() {
        // Inside cells at 76 m; one outside hollow cell at 74 m.
        var grid = makeGrid(
            width: 10, height: 10,
            z: { _, _ in 76 },
            inside: { row, col in row >= 3 && row <= 6 && col >= 3 && col <= 6 }
        )
        grid.heights[1 * 10 + 1] = 74 // hollow in the surrounds
        let slope = computeSlopeGrid(grid)
        let stats = computeStats(grid, slope: slope)

        XCTAssertEqual(stats.green.minHeight, 76)
        XCTAssertEqual(stats.green.maxHeight, 76)
        XCTAssertEqual(stats.green.deltaHeight, 0)
        XCTAssertEqual(stats.green.meanHeight, 76, accuracy: 1e-10)
        XCTAssertEqual(stats.surrounds.deepestHollowM, 2, accuracy: 1e-10)
        // Relative scale = max |h − mean| over ALL cells = the hollow's 2 m.
        XCTAssertEqual(stats.relScaleM, 2, accuracy: 1e-10)
    }

    func testComputeStatsCapsTheRelativeScale() {
        var grid = makeGrid(
            width: 10, height: 10,
            z: { _, _ in 76 },
            inside: { row, col in row >= 3 && row <= 6 && col >= 3 && col <= 6 }
        )
        grid.heights[0] = 86 // 10 m hill in the surrounds
        let stats = computeStats(grid, slope: computeSlopeGrid(grid))
        XCTAssertEqual(stats.relScaleM, REL_SCALE_MAX_M)
    }

    func testComputeStatsFloorsTheRelativeScaleOnDeadFlatSite() {
        let grid = makeGrid(width: 6, height: 6) { _, _ in 50 }
        let stats = computeStats(grid, slope: computeSlopeGrid(grid))
        XCTAssertEqual(stats.relScaleM, REL_SCALE_MIN_M)
        XCTAssertEqual(stats.surrounds.deepestHollowM, 0)
    }

    func testComputeStatsSlopeStatsComeFromInsideCellsOnly() {
        let grid = makeGrid(
            width: 12, height: 10,
            z: { e, n in 50 + 0.03 * (e - 1000) + 0.04 * (n - 1990) },
            inside: { row, col in row >= 2 && row <= 7 && col >= 2 && col <= 9 }
        )
        let stats = computeStats(grid, slope: computeSlopeGrid(grid))
        XCTAssertEqual(stats.green.maxSlopePct, 5, accuracy: 1e-8)
        XCTAssertEqual(stats.green.avgSlopePct, 5, accuracy: 1e-8)
        XCTAssertEqual(stats.surrounds.maxSlopePct, 5, accuracy: 1e-8)
    }

    // MARK: - Grid → RGBA mapping

    func testOverlayImageInsideFullAlphaOutsideReducedNodataTransparent() {
        // cells: [nan outside] [60 inside] [60 outside]
        let grid = SampleGrid(
            spec: AnalysisGridSpec(originE: 1000, originN: 2000, resolution: 0.5, width: 3, height: 1),
            heights: [.nan, 60, 60],
            insideMask: [false, true, false]
        )
        let slope = computeSlopeGrid(grid)
        let stats = computeStats(grid, slope: slope)
        let rgba = buildOverlayRgba(grid, mode: .height, slope: slope, stats: stats)
        XCTAssertEqual(rgba[3], 0) // nodata → transparent
        XCTAssertEqual(rgba[7], INSIDE_ALPHA)
        XCTAssertEqual(rgba[11], OUTSIDE_ALPHA)
        XCTAssertEqual(INSIDE_ALPHA, 217) // 0.85 * 255
        XCTAssertEqual(OUTSIDE_ALPHA, 140) // 0.55 * 255
    }

    func testHeightModeNormalizesColorsToTheInsideMinMax() {
        // Inside spans 70..71; an outside cell at 80 must clamp to red.
        let grid = SampleGrid(
            spec: AnalysisGridSpec(originE: 1000, originN: 2000, resolution: 0.5, width: 4, height: 1),
            heights: [70, 70.5, 71, 80],
            insideMask: [true, true, true, false]
        )
        let slope = computeSlopeGrid(grid)
        let stats = computeStats(grid, slope: slope)
        let rgba = buildOverlayRgba(grid, mode: .height, slope: slope, stats: stats)
        func px(_ i: Int) -> AnalysisRGB {
            AnalysisRGB(Int(rgba[i * 4]), Int(rgba[i * 4 + 1]), Int(rgba[i * 4 + 2]))
        }
        XCTAssertEqual(px(0), HEIGHT_STOPS[0]) // inside min → blue
        XCTAssertEqual(px(1), HEIGHT_STOPS[2]) // inside middle → yellow
        XCTAssertEqual(px(2), HEIGHT_STOPS[4]) // inside max → red
        XCTAssertEqual(px(3), HEIGHT_STOPS[4]) // above-green surrounds clamp to red
    }

    func testRelativeModePaintsHollowsBluePurpleAndMoundsWarm() {
        let grid = SampleGrid(
            spec: AnalysisGridSpec(originE: 1000, originN: 2000, resolution: 0.5, width: 3, height: 1),
            heights: [74, 76, 78], // hollow | green level | mound
            insideMask: [false, true, false]
        )
        let slope = computeSlopeGrid(grid)
        let stats = computeStats(grid, slope: slope) // mean 76, scale 2
        let rgba = buildOverlayRgba(grid, mode: .relative, slope: slope, stats: stats)
        func px(_ i: Int) -> AnalysisRGB {
            AnalysisRGB(Int(rgba[i * 4]), Int(rgba[i * 4 + 1]), Int(rgba[i * 4 + 2]))
        }
        XCTAssertEqual(px(0), REL_BELOW_STOPS[3]) // 2 m below → purple
        XCTAssertEqual(px(1), REL_NEUTRAL) // green level
        XCTAssertEqual(px(2), REL_ABOVE_STOPS[3]) // 2 m above → red
    }

    func testSlopeModeColorsCellsByTheSlopeRamp() {
        let grid = planeGrid() // 5% everywhere
        let slope = computeSlopeGrid(grid)
        let stats = computeStats(grid, slope: slope)
        let rgba = buildOverlayRgba(grid, mode: .slope, slope: slope, stats: stats)
        XCTAssertEqual(AnalysisRGB(Int(rgba[0]), Int(rgba[1]), Int(rgba[2])), SLOPE_ORANGE)
    }

    // MARK: - Fall-line arrows

    func testFallLineArrowsSamplingDirectionAndLabels() {
        // 40×40 cells @ 0.5 m = 20×20 m → spacing max(1.5, 20/10) = 2 m → 10×10.
        let grid = makeGrid(width: 40, height: 40) { e, n in
            50 + 0.03 * (e - 1000) + 0.04 * (n - 1980)
        }
        let arrows = sampleFallLines(grid, slope: computeSlopeGrid(grid))
        XCTAssertEqual(arrows.count, 100)
        for a in arrows {
            XCTAssertEqual(a.slopePct, 5, accuracy: 1e-6)
            XCTAssertEqual(a.dirE, -0.6, accuracy: 1e-6)
            XCTAssertEqual(a.dirN, -0.8, accuracy: 1e-6)
            XCTAssertGreaterThan(a.slopePct, ARROW_MIN_SLOPE_PCT)
        }
        XCTAssertEqual(arrows.filter(\.labeled).count, 34) // every 3rd (ARROW_LABEL_EVERY)
        XCTAssertTrue(arrows[0].labeled)
        XCTAssertFalse(arrows[1].labeled)
        XCTAssertTrue(arrows[3].labeled)
    }

    func testFallLineArrowsSkipNearFlatCells() {
        let grid = makeGrid(width: 40, height: 40) { _, _ in 50 }
        let arrows = sampleFallLines(grid, slope: computeSlopeGrid(grid))
        XCTAssertTrue(arrows.isEmpty)
    }

    func testFallLineArrowSpacingNeverDropsBelowOnePointFiveMeters() {
        // Tiny 4×4 m green: min(w,h)/10 = 0.4 → clamped to 1.5 m → 3×3 samples.
        let grid = makeGrid(width: 8, height: 8) { e, n in
            50 + 0.05 * (e - 1000) + 0.05 * (n - 1996)
        }
        let arrows = sampleFallLines(grid, slope: computeSlopeGrid(grid))
        XCTAssertEqual(arrows.count, 9)
    }

    // MARK: - 1 m reference grid

    func testMeterGridLinesAlignToWholeMetersAndSpanTheSampledRect() {
        // Extent: e 1000–1006, n 1995–2000 (12×10 cells @ 0.5 m).
        let lines = buildMeterGridLines(planeGrid().spec)
        let vertical = lines.filter { $0.e0 == $0.e1 }
        let horizontal = lines.filter { $0.n0 == $0.n1 }
        XCTAssertEqual(vertical.count, 7) // e = 1000...1006
        XCTAssertEqual(horizontal.count, 6) // n = 1995...2000
        for line in vertical {
            XCTAssertEqual(line.e0.truncatingRemainder(dividingBy: 1), 0)
            XCTAssertEqual(max(line.n0, line.n1), 2000)
            XCTAssertEqual(min(line.n0, line.n1), 1995)
        }
        for line in horizontal {
            XCTAssertEqual(line.n0.truncatingRemainder(dividingBy: 1), 0)
            XCTAssertEqual(min(line.e0, line.e1), 1000)
            XCTAssertEqual(max(line.e0, line.e1), 1006)
        }
    }

    func testMeterGridLinesSnapInwardFromAFractionalOrigin() {
        // Extent: e 1000.3–1002.3, n 1998.7–2000.7.
        let spec = AnalysisGridSpec(
            originE: 1000.3, originN: 2000.7, resolution: 0.5, width: 4, height: 4
        )
        let lines = buildMeterGridLines(spec)
        let vertical = lines.filter { $0.e0 == $0.e1 }.map(\.e0)
        let horizontal = lines.filter { $0.n0 == $0.n1 }.map(\.n0)
        XCTAssertEqual(vertical, [1001, 1002])
        XCTAssertEqual(horizontal, [1999, 2000])
    }

    // MARK: - Elevation contours (marching squares)

    func testContoursOnEastTiltedPlaneAreVerticalLinesAtExactLevelPositions() {
        // z = 50 + 0.1·(e − 1000): contours are north–south lines, one per
        // 2 cm, at e = 1000 + (level − 50) / 0.1.
        let grid = makeGrid(width: 12, height: 10) { e, _ in 50 + 0.1 * (e - 1000) }
        let contours = computeContours(grid)
        XCTAssertGreaterThan(contours.count, 20)
        for c in contours {
            // Level is a 2 cm multiple; index flag on 10 cm multiples.
            let k = Int((c.level / CONTOUR_INTERVAL_M).rounded())
            XCTAssertEqual(c.level, Double(k) * CONTOUR_INTERVAL_M, accuracy: 1e-9)
            XCTAssertEqual(c.index, k % CONTOUR_INDEX_EVERY == 0)
            XCTAssertFalse(c.segments.isEmpty)
            let expectedE = 1000 + (c.level - 50) / 0.1
            for seg in c.segments {
                XCTAssertEqual(seg.e0, expectedE, accuracy: 1e-6)
                XCTAssertEqual(seg.e1, expectedE, accuracy: 1e-6)
                XCTAssertNotEqual(seg.n0, seg.n1) // north–south segment
            }
        }
        // Consecutive levels are exactly one interval apart (no gaps).
        for i in 1..<contours.count {
            XCTAssertEqual(
                contours[i].level - contours[i - 1].level,
                CONTOUR_INTERVAL_M,
                accuracy: 1e-9
            )
        }
    }

    func testContoursSkipNodataBlocksAndFlatGridYieldsNone() {
        XCTAssertTrue(computeContours(makeGrid(width: 8, height: 8) { _, _ in 50 }).isEmpty)
        XCTAssertTrue(computeContours(makeGrid(width: 8, height: 8) { _, _ in .nan }).isEmpty)
        // Half the grid nodata: contours exist only where data is.
        let grid = makeGrid(width: 12, height: 10) { e, n in
            n > 1997.5 ? .nan : 50 + 0.1 * (e - 1000)
        }
        let contours = computeContours(grid)
        XCTAssertFalse(contours.isEmpty)
        for c in contours {
            for seg in c.segments {
                XCTAssertLessThanOrEqual(seg.n0, 1997.5)
                XCTAssertLessThanOrEqual(seg.n1, 1997.5)
            }
        }
    }

    func testContourSegmentsStayWithinTheSampledNodeExtent() {
        let grid = makeGrid(width: 12, height: 10) { e, n in
            50 + 0.06 * (e - 1000) + 0.04 * (n - 1990) + 0.05 * sin(e) * cos(n)
        }
        for c in computeContours(grid) {
            for seg in c.segments {
                for e in [seg.e0, seg.e1] {
                    XCTAssertGreaterThanOrEqual(e, 1000.25)
                    XCTAssertLessThanOrEqual(e, 1005.75)
                }
                for n in [seg.n0, seg.n1] {
                    XCTAssertGreaterThanOrEqual(n, 1995.25)
                    XCTAssertLessThanOrEqual(n, 1999.75)
                }
            }
        }
    }
}
