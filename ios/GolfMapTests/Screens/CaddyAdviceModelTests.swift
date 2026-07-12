import XCTest
@testable import GolfMap

/// Green-view smart-caddy composition (Part B) — the `GreenSlopeAdapter`
/// reduction over a synthetic tilted grid, plus the `CaddyAdviceModel`
/// competition gating and no-grid behaviour. The pure evaluator/rule parity is
/// covered by `CaddyGoldenParityTests`; this exercises the platform seam.
@MainActor
final class CaddyAdviceModelTests: XCTestCase {

    /// A 10×10 m green grid tilting steadily DOWN toward the south (lower
    /// northing), a 4% back-to-front fall for a player approaching from the
    /// south, built around a real EPSG:3006 point so the projected origin /
    /// front / back stay in the grid's frame. Returns the grid + the WGS84
    /// origin (40 m south) + the green targets (front 5 m south, back 5 m north).
    private static func firingScenario() -> (grid: SampleGrid, origin: LatLon, targets: HoleTargets) {
        let centerLL = LatLon(lat: 58.3640, lon: 15.7080)
        let c = Sweref99TM.fromWGS84(centerLL)
        let frontLL = Sweref99TM.toWGS84(x: c.x, y: c.y - 5) // south (near the player)
        let backLL = Sweref99TM.toWGS84(x: c.x, y: c.y + 5)  // north
        let originLL = Sweref99TM.toWGS84(x: c.x, y: c.y - 40) // player 40 m south, plays north

        let res = 1.0
        let width = 10, height = 10
        let spec = AnalysisGridSpec(
            originE: c.x - 5, originN: c.y + 5, resolution: res, width: width, height: height
        )
        // Height rises toward the north (higher northing) → downhill toward the
        // south, a steady 4% slope (0.04 m per m of northing).
        var heights = [Double](repeating: 0, count: width * height)
        for row in 0..<height {
            let n = spec.originN - (Double(row) + 0.5) * res
            for col in 0..<width {
                heights[row * width + col] = n * 0.04
            }
        }
        let grid = SampleGrid(
            spec: spec, heights: heights, insideMask: [Bool](repeating: true, count: width * height)
        )
        let targets = HoleTargets(
            greenFront: frontLL, greenCenter: centerLL, greenBack: backLL, greenElevation: 25
        )
        return (grid, originLL, targets)
    }

    // MARK: - GreenSlopeAdapter

    func testSummarizeYieldsBackToFrontFallLine() {
        let (grid, _, targets) = Self.firingScenario()
        let f = Sweref99TM.fromWGS84(targets.greenFront!)
        let b = Sweref99TM.fromWGS84(targets.greenBack!)
        let summary = try! XCTUnwrap(GreenSlopeAdapter.summarize(
            grid: grid,
            front: GreenSlopeAdapter.RefPoint(e: f.x, n: f.y),
            back: GreenSlopeAdapter.RefPoint(e: b.x, n: b.y)
        ))
        // ~4% fall, dominant fall line pointing due south (compass 180°).
        XCTAssertEqual(summary.fallLinePct, 4, accuracy: 1e-6)
        XCTAssertEqual(summary.fallLineBearingDeg, 180, accuracy: 1e-6)
    }

    func testSummarizeReturnsNilForAllNodataGrid() {
        let spec = AnalysisGridSpec(originE: 0, originN: 10, resolution: 1, width: 4, height: 4)
        let grid = SampleGrid(
            spec: spec,
            heights: [Double](repeating: .nan, count: 16),
            insideMask: [Bool](repeating: true, count: 16)
        )
        XCTAssertNil(GreenSlopeAdapter.summarize(
            grid: grid,
            front: GreenSlopeAdapter.RefPoint(e: 0, n: 0),
            back: GreenSlopeAdapter.RefPoint(e: 0, n: 10)
        ))
    }

    // MARK: - CaddyAdviceModel

    func testAdviceFiresOnBackToFrontGreen() {
        let m = CaddyAdviceModel()
        let (grid, origin, targets) = Self.firingScenario()
        m.recompute(
            grid: grid, origin: origin, targets: targets, hazards: [],
            par: 4, strokeIndex: 1, competition: false
        )
        let advice = try! XCTUnwrap(m.advice)
        XCTAssertEqual(advice.ruleId, "green-slope-half")
        XCTAssertEqual(advice.kind, .targetHalf)
        XCTAssertTrue(advice.headline.contains("short half"))
    }

    func testAdviceWithheldInCompetitionMode() {
        let m = CaddyAdviceModel()
        let (grid, origin, targets) = Self.firingScenario()
        m.recompute(
            grid: grid, origin: origin, targets: targets, hazards: [],
            par: 4, strokeIndex: 1, competition: true
        )
        XCTAssertNil(m.advice, "caddy advice is advice → withheld in competition mode")
    }

    func testNoGridNoAdvice() {
        let m = CaddyAdviceModel()
        let (_, origin, targets) = Self.firingScenario()
        m.recompute(
            grid: nil, origin: origin, targets: targets, hazards: [],
            par: 4, strokeIndex: 1, competition: false
        )
        XCTAssertNil(m.advice, "no green-view grid → no advice on the hole view")
    }

    func testClearDropsAdvice() {
        let m = CaddyAdviceModel()
        let (grid, origin, targets) = Self.firingScenario()
        m.recompute(
            grid: grid, origin: origin, targets: targets, hazards: [],
            par: 4, strokeIndex: 1, competition: false
        )
        XCTAssertNotNil(m.advice)
        m.clear()
        XCTAssertNil(m.advice)
    }
}
